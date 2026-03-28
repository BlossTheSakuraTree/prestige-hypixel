require("dotenv").config();
const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const HYPIXEL_KEY = process.env.HYPIXEL_API_KEY;
const NOTIFICATION_CHANNEL = process.env.NOTIFICATION_CHANNEL;

if (!TOKEN || !HYPIXEL_KEY || !NOTIFICATION_CHANNEL) {
    console.error("Missing environment variables");
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const DATA_FILE = process.env.DATA_PATH || require("path").join(__dirname, "data.json");
let data = { players: {}, threads: {} };

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    }
    for (const username in data.players) {
        data.players[username].currentGame   = null;
        data.players[username].startStats    = null;
        data.players[username].firstPollDone = false;
    }
    saveData();
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const MIN_REQUEST_GAP = 500;
let lastRequestTime  = 0;
let rateLimitedUntil = 0;
let requestQueue     = Promise.resolve();

function hypixelRequest(url) {
    const result = requestQueue.then(async () => {
        const now = Date.now();
        if (rateLimitedUntil > now) {
            const wait = rateLimitedUntil - now;
            console.warn("[queue] Rate limited - waiting " + (wait / 1000).toFixed(1) + "s");
            await sleep(wait);
        }

        const gap = Date.now() - lastRequestTime;
        if (gap < MIN_REQUEST_GAP) {
            await sleep(MIN_REQUEST_GAP - gap);
        }

        lastRequestTime = Date.now();

        try {
            return await axios.get(url);
        } catch (err) {
            if (err?.response?.status === 429) {
                const retryAfter = parseInt(err.response.headers?.["retry-after"] || "10000");
                rateLimitedUntil = Date.now() + retryAfter;
                console.warn("[queue] 429 - blocking requests for " + (retryAfter / 1000).toFixed(1) + "s");
            }
            throw err;
        }
    });

    requestQueue = result.catch(() => {});
    return result;
}

function idleDelay() {
    const rateLimitBuffer = Math.max(0, rateLimitedUntil - Date.now());
    return Math.max(POLL_INTERVAL_IDLE, rateLimitBuffer + POLL_INTERVAL_IDLE);
}

async function getUUID(username) {
    try {
        const res = await axios.get("https://api.mojang.com/users/profiles/minecraft/" + username);
        return { uuid: res.data.id, canonicalName: res.data.name };
    } catch {
        return null;
    }
}

async function getRecentGames(uuid) {
    const res = await hypixelRequest("https://api.hypixel.net/recentgames?key=" + HYPIXEL_KEY + "&uuid=" + uuid);
    return res.data.games || [];
}

async function getStats(uuid) {
    const res = await hypixelRequest("https://api.hypixel.net/player?key=" + HYPIXEL_KEY + "&uuid=" + uuid);
    return res.data.player?.stats?.Bedwars || {};
}

async function validateHypixelKey() {
    try {
        const res = await hypixelRequest("https://api.hypixel.net/key?key=" + HYPIXEL_KEY);
        if (!res.data?.success) {
            console.error("Hypixel API key is invalid or has been revoked.");
            console.error("Generate a new key at: https://developer.hypixel.net/");
            process.exit(1);
        }
        console.log("Hypixel API key validated.");
    } catch (err) {
        const status = err?.response?.status;
        if (status === 403 || status === 401) {
            console.error("Hypixel API key rejected (HTTP " + status + ").");
            console.error("Generate a new key at: https://developer.hypixel.net/");
            process.exit(1);
        }
        console.warn("Could not validate Hypixel API key at startup:", err.message);
    }
}

async function checkPlayerApiFlags(uuid) {
    try {
        const games = await getRecentGames(uuid);
        const stats = await getStats(uuid);

        const hasPlayedBefore    = (stats.games_played_bedwars || 0) > 0;
        const recentGamesEnabled = !(hasPlayedBefore && games.length === 0);
        const winstreakEnabled   =
            !hasPlayedBefore ||
            stats.winstreak !== undefined ||
            stats.eight_one_winstreak !== undefined ||
            stats.eight_two_winstreak !== undefined ||
            stats.four_three_winstreak !== undefined ||
            stats.four_four_winstreak !== undefined;

        console.log("[api flags] uuid=" + uuid +
            " gamesPlayed=" + (stats.games_played_bedwars || 0) +
            " recentGamesCount=" + games.length +
            " recentGamesEnabled=" + recentGamesEnabled +
            " winstreakEnabled=" + winstreakEnabled +
            " winstreak=" + stats.winstreak +
            " eight_one_winstreak=" + stats.eight_one_winstreak);

        return { recentGamesEnabled, winstreakEnabled };
    } catch (err) {
        console.error("[api flags] Failed for " + uuid + ":", err.message);
        return { recentGamesEnabled: null, winstreakEnabled: null };
    }
}

// Bypasses the queue intentionally - this check is time-sensitive and must
// fire close to NICK_CHECK_DELAY ms after the game starts. Going through the
// queue would delay it by however long the backlog is, making the window
// unreliable. The status endpoint is cheap and called at most once per game.
async function isPlayerNicked(uuid, expectedGameType) {
    try {
        const res = await axios.get("https://api.hypixel.net/status?key=" + HYPIXEL_KEY + "&uuid=" + uuid);

        if (!res.data?.success) {
            console.warn("[nick check] API returned success:false, assuming not nicked");
            return false;
        }

        const session = res.data.session;

        if (!session?.online) {
            console.log("[nick check] " + uuid + " offline while in-game - likely nicked");
            return true;
        }

        if (expectedGameType && session.gameType === expectedGameType) {
            console.log("[nick check] " + uuid + " visible in " + session.gameType + " - not nicked");
            return false;
        }

        console.log("[nick check] " + uuid + " online in " + (session.gameType || "unknown") + ", expected " + expectedGameType + " - not nicked");
        return false;
    } catch (err) {
        console.warn("[nick check] Failed, assuming not nicked:", err.message);
        return false;
    }
}

const MODE_INFO = {
    EIGHT_ONE:  { label: "Solos",   streakKey: "eight_one_winstreak"  },
    EIGHT_TWO:  { label: "Doubles", streakKey: "eight_two_winstreak"  },
    FOUR_THREE: { label: "Threes",  streakKey: "four_three_winstreak" },
    FOUR_FOUR:  { label: "Fours",   streakKey: "four_four_winstreak"  },
};

function getModeInfo(mode) {
    const stripped = (mode || "").toUpperCase().replace(/^BEDWARS_/, "");
    return MODE_INFO[stripped] || { label: mode || "Unknown", streakKey: "winstreak" };
}

function fkdr(stats) {
    return (stats.final_kills_bedwars || 0) / Math.max(1, stats.final_deaths_bedwars || 1);
}

function wlr(stats) {
    return (stats.wins_bedwars || 0) / Math.max(1, stats.losses_bedwars || 1);
}

function signed(n) {
    return (n >= 0 ? "+" : "") + n.toFixed(3);
}

const POLL_INTERVAL_ACTIVE = 12000;
const POLL_INTERVAL_IDLE   = 20000;
const STAGGER_STEP         = 3000;
const NICK_CHECK_DELAY     = 15000;

function findPlayerKeyByUUID(uuid) {
    return Object.keys(data.players).find(k => data.players[k].uuid === uuid) || null;
}

async function getOrCreateThread(username) {
    if (data.threads[username]) {
        try {
            return await client.channels.fetch(data.threads[username]);
        } catch {
            delete data.threads[username];
            saveData();
        }
    }

    const channel = await client.channels.fetch(NOTIFICATION_CHANNEL);
    const thread = await channel.threads.create({
        name: "Notifications-" + username,
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: 60
    });

    for (const userId of data.players[username]?.discordUsers || []) {
        try { await thread.members.add(userId); } catch {}
    }

    data.threads[username] = thread.id;
    saveData();
    return thread;
}

async function deleteThreadForPlayer(username) {
    if (!data.threads[username]) return;
    try {
        const thread = await client.channels.fetch(data.threads[username]);
        await thread.delete();
    } catch {}
    delete data.threads[username];
    saveData();
}

async function addPlayer(inputUsername, userId) {
    const result = await getUUID(inputUsername);
    if (!result) return { success: false, canonicalName: null };

    const { uuid, canonicalName } = result;
    const existingKey = findPlayerKeyByUUID(uuid);

    if (existingKey) {
        if (data.players[existingKey].discordUsers.includes(userId)) {
            return { success: true, canonicalName: existingKey, recentGamesEnabled: null, winstreakEnabled: null, alreadyTracking: true };
        }

        data.players[existingKey].discordUsers.push(userId);

        if (data.threads[existingKey]) {
            try {
                const thread = await client.channels.fetch(data.threads[existingKey]);
                await thread.members.add(userId);
            } catch {}
        }

        saveData();

        const { recentGamesEnabled, winstreakEnabled } = await checkPlayerApiFlags(uuid);
        return { success: true, canonicalName: existingKey, recentGamesEnabled, winstreakEnabled, alreadyTracking: false };
    }

    const { recentGamesEnabled, winstreakEnabled } = await checkPlayerApiFlags(uuid);

    data.players[canonicalName] = {
        uuid,
        discordUsers: [userId],
        trackedGames: ["BEDWARS"],
        currentGame:   null,
        startStats:    null,
        lastGameId:    null,
        firstPollDone: false
    };
    startPollingPlayer(canonicalName, 0);

    saveData();
    return { success: true, canonicalName, recentGamesEnabled, winstreakEnabled };
}

async function removePlayer(inputUsername, userId) {
    let key = data.players[inputUsername] ? inputUsername : null;

    if (!key) {
        key = Object.keys(data.players).find(
            k => k.toLowerCase() === inputUsername.toLowerCase()
        ) || null;
    }

    if (!key) return false;

    data.players[key].discordUsers =
        data.players[key].discordUsers.filter(id => id !== userId);

    if (data.players[key].discordUsers.length === 0) {
        if (playerTimers[key]) {
            clearTimeout(playerTimers[key]);
            delete playerTimers[key];
        }
        await deleteThreadForPlayer(key);
        delete data.players[key];
    }

    saveData();
    return true;
}

function listPlayers(userId) {
    return Object.keys(data.players).filter(p =>
        data.players[p].discordUsers.includes(userId)
    );
}

const playerTimers = {};

async function pollPlayer(username) {
    const player = data.players[username];
    if (!player) return;

    try {
        if (player.currentGame && player.startStats) {
            const cur  = await getStats(player.uuid);
            const prev = player.startStats;

            const gotEliminated = (cur.final_deaths_bedwars || 0) > (prev.final_deaths_bedwars || 0);
            const gotWin        = (cur.wins_bedwars || 0)          > (prev.wins_bedwars || 0);

            if (gotEliminated || gotWin) {
                const thread = await getOrCreateThread(username);
                const { label: modeLabel, streakKey } = getModeInfo(player.currentGame.mode);

                const fkdrBefore = fkdr(prev);
                const fkdrAfter  = fkdr(cur);
                const wlrBefore  = wlr(prev);
                const wlrAfter   = wlr(cur);

                const streakBefore = prev[streakKey] ?? prev.winstreak;
                const streakAfter  = cur[streakKey]  ?? cur.winstreak;
                const winstreakApiOff = streakBefore === undefined && streakAfter === undefined;

                let streakLine;
                if (winstreakApiOff) {
                    streakLine = "Winstreak: ? \u2192 ?";
                } else if (streakAfter === 0) {
                    streakLine = "Winstreak: reset to 0";
                } else {
                    const streakDiff = (streakAfter ?? 0) - (streakBefore ?? 0);
                    streakLine = "Winstreak: " + (streakDiff >= 0 ? "+" : "") + streakDiff + " (now " + streakAfter + ")";
                }

                const outcome = gotWin ? "won" : "was eliminated from";

                await thread.send(
                    (gotWin ? ":trophy:" : ":skull:") + " **" + username + "** " + outcome + " a **" + modeLabel + "** game\n" +
                    "FKDR: " + signed(fkdrAfter - fkdrBefore) + " (now " + fkdrAfter.toFixed(3) + ")\n" +
                    "WLR: " + signed(wlrAfter - wlrBefore) + " (now " + wlrAfter.toFixed(3) + ")\n" +
                    streakLine
                );

                player.currentGame = null;
                player.startStats  = null;
                saveData();

                playerTimers[username] = setTimeout(() => pollPlayer(username), idleDelay());
                return;
            }

            playerTimers[username] = setTimeout(() => pollPlayer(username), POLL_INTERVAL_ACTIVE);
            return;
        }

        const recentGames = await getRecentGames(player.uuid);
        const latestGame  = recentGames.find(g =>
            player.trackedGames.includes((g.gameType || "").toUpperCase())
        );

        if (!player.firstPollDone) {
            player.lastGameId    = latestGame ? latestGame.date : null;
            player.firstPollDone = true;
            saveData();
            playerTimers[username] = setTimeout(() => pollPlayer(username), POLL_INTERVAL_IDLE);
            return;
        }

        if (latestGame && latestGame.date !== player.lastGameId) {
            const thread = await getOrCreateThread(username);
            const { label: modeLabel } = getModeInfo(latestGame.mode);

            player.currentGame = {
                id:   latestGame.date,
                map:  latestGame.map,
                type: latestGame.gameType,
                mode: latestGame.mode
            };
            player.startStats = await getStats(player.uuid);
            player.lastGameId = latestGame.date;
            saveData();

            const startMsg = await thread.send(
                ":video_game: **" + username + "** started a **" + modeLabel + "** game\n" +
                "Map: **" + latestGame.map + "**"
            );

            const capturedUuid     = player.uuid;
            const capturedGameType = latestGame.gameType;
            const capturedMap      = latestGame.map;
            const capturedLabel    = modeLabel;

            sleep(NICK_CHECK_DELAY).then(async () => {
                if (!data.players[username]) return;
                const nicked = await isPlayerNicked(capturedUuid, capturedGameType);
                if (nicked) {
                    try {
                        await startMsg.edit(
                            ":video_game: **" + username + "** started a **" + capturedLabel + "** game\n" +
                            "Map: **" + capturedMap + "**\n" +
                            ":disguised_face: Player appears to be **nicked**"
                        );
                    } catch {}
                }
            });

            playerTimers[username] = setTimeout(() => pollPlayer(username), POLL_INTERVAL_ACTIVE);
            return;
        }

    } catch (err) {
        const status = err?.response?.status;

        if (status === 403 || status === 401) {
            console.error("[" + username + "] Fatal: Hypixel API key rejected (HTTP " + status + "). Stopping poll.");
            return;
        }

        console.error("[" + username + "] Poll error:", err.message);
    }

    playerTimers[username] = setTimeout(() => pollPlayer(username), idleDelay());
}

function startPollingPlayer(username, delay) {
    if (playerTimers[username]) clearTimeout(playerTimers[username]);
    playerTimers[username] = setTimeout(() => pollPlayer(username), delay);
}

client.once("clientReady", async () => {
    console.log("Logged in as " + client.user.tag);
    await validateHypixelKey();
    loadData();

    Object.keys(data.players).forEach((username, i) => {
        startPollingPlayer(username, i * STAGGER_STEP);
    });

    const commands = [
        new SlashCommandBuilder()
            .setName("addplayer")
            .setDescription("Track a Minecraft player")
            .addStringOption(o =>
                o.setName("username").setDescription("Minecraft username").setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName("removeplayer")
            .setDescription("Stop tracking a player")
            .addStringOption(o =>
                o.setName("username").setDescription("Minecraft username").setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName("removeall")
            .setDescription("Stop tracking all your players"),
        new SlashCommandBuilder()
            .setName("listplayers")
            .setDescription("List your tracked players")
    ].map(c => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    try {
        const notifChannel = await client.channels.fetch(NOTIFICATION_CHANNEL);
        notificationChannelName = notifChannel.name;
    } catch {
        console.warn("Could not fetch notification channel name");
    }

    setTimeout(() => {
        botReady = true;
        console.log("Bot ready - thread sync active");
    }, 5000);
});

let botReady = false;
let notificationChannelName = null;

client.on("threadDelete", thread => {
    if (!botReady) return;

    const username = Object.keys(data.threads).find(u => data.threads[u] === thread.id);
    if (!username) return;

    console.log("[sync] Thread for " + username + " deleted - removing all trackers");

    if (playerTimers[username]) {
        clearTimeout(playerTimers[username]);
        delete playerTimers[username];
    }

    delete data.threads[username];
    delete data.players[username];
    saveData();
});

client.on("threadMembersUpdate", (addedMembers, removedMembers, thread) => {
    if (!botReady) return;
    if (removedMembers.size === 0) return;

    const username = Object.keys(data.threads).find(u => data.threads[u] === thread.id);
    if (!username) return;

    for (const [userId] of removedMembers) {
        if (userId === client.user.id) continue;
        if (data.players[username]?.discordUsers.includes(userId)) {
            removePlayer(username, userId);
            console.log("[sync] User " + userId + " left thread for " + username + " - removed from tracking");
        }
    }
});

client.on("interactionCreate", async interaction => {
    const isInCorrectChannel = interaction.channelId === NOTIFICATION_CHANNEL;
    const isInChildThread    = interaction.channel?.parentId === NOTIFICATION_CHANNEL;

    if (!isInCorrectChannel && !isInChildThread) {
        const name = notificationChannelName || NOTIFICATION_CHANNEL;
        return interaction.reply({
            content: "You can't use this bot in here! Head to the #" + name + " channel to use the bot.",
            flags: MessageFlags.Ephemeral
        });
    }

    if (interaction.isButton()) {
        const userId = interaction.user.id;

        if (interaction.customId === "removeall_confirm") {
            const list = listPlayers(userId);
            await Promise.all(list.map(username => removePlayer(username, userId)));
            return interaction.update({
                content: "Stopped tracking " + list.length + " player" + (list.length !== 1 ? "s" : "") + ".",
                components: []
            });
        }

        if (interaction.customId === "removeall_cancel") {
            return interaction.update({ content: "Cancelled.", components: [] });
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;

    if (interaction.commandName === "addplayer") {
        const inputUsername = interaction.options.getString("username");
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { success, canonicalName, recentGamesEnabled, winstreakEnabled, alreadyTracking } = await addPlayer(inputUsername, userId);
        if (!success) return interaction.editReply("Could not find player **" + inputUsername + "**");
        if (alreadyTracking) return interaction.editReply("You are already tracking **" + canonicalName + "**!");

        await getOrCreateThread(canonicalName);

        const warnings = [];
        if (recentGamesEnabled === false) warnings.push("⚠️ **Warning:** **" + canonicalName + "** has their Recent Games API disabled on Hypixel, or they haven't logged in in a long time. The bot won't be able to detect when they start a game unless they enable it again in their Hypixel API settings.");
        if (winstreakEnabled === false)   warnings.push("⚠️ **Warning:** **" + canonicalName + "** has their Winstreak API disabled on Hypixel. Winstreak changes will show as **? → ?** unless they enable it again in their Hypixel API settings.");

        const warningText = warnings.length ? "\n\n" + warnings.join("\n\n") : "";
        return interaction.editReply("Now tracking **" + canonicalName + "**" + warningText);
    }

    if (interaction.commandName === "removeplayer") {
        const inputUsername = interaction.options.getString("username");
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const success = await removePlayer(inputUsername, userId);
        return interaction.editReply(
            success
                ? "Stopped tracking **" + inputUsername + "**"
                : "You are not tracking **" + inputUsername + "**"
        );
    }

    if (interaction.commandName === "removeall") {
        const list = listPlayers(userId);
        if (!list.length) {
            return interaction.reply({ content: "You are not tracking any players.", flags: MessageFlags.Ephemeral });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("removeall_confirm")
                .setLabel("Yes, remove all")
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId("removeall_cancel")
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
            content: "Stop tracking " + list.length + " player" + (list.length !== 1 ? "s" : "") + "? (" + list.join(", ") + ")",
            components: [row],
            flags: MessageFlags.Ephemeral
        });

        setTimeout(async () => {
            try { await interaction.editReply({ content: "Confirmation expired.", components: [] }); } catch {}
        }, 30000);

        return;
    }

    if (interaction.commandName === "listplayers") {
        const list = listPlayers(userId);
        return interaction.reply({
            content: list.length ? "Tracking: " + list.join(", ") : "You are not tracking any players.",
            flags: MessageFlags.Ephemeral
        });
    }
});

client.login(TOKEN);
