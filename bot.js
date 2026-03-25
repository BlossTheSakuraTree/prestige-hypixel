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

const DATA_FILE = process.env.DATA_PATH || "/data/data.json";
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

// Returns { uuid, canonicalName } or null
async function getUUID(username) {
    try {
        const res = await axios.get("https://api.mojang.com/users/profiles/minecraft/" + username);
        return { uuid: res.data.id, canonicalName: res.data.name };
    } catch {
        return null;
    }
}

async function getRecentGames(uuid) {
    const res = await axios.get("https://api.hypixel.net/recentgames?key=" + HYPIXEL_KEY + "&uuid=" + uuid);
    return res.data.games || [];
}

async function getStats(uuid) {
    const res = await axios.get("https://api.hypixel.net/player?key=" + HYPIXEL_KEY + "&uuid=" + uuid);
    return res.data.player?.stats?.Bedwars || {};
}

async function isPlayerNicked(uuid) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await axios.get("https://api.hypixel.net/status?key=" + HYPIXEL_KEY + "&uuid=" + uuid);
            const online = res.data?.session?.online ?? true;
            return !online;
        } catch (err) {
            if (err?.response?.status === 429 && attempt === 0) {
                const wait = parseInt(err.response.headers["retry-after"] || "10000");
                await sleep(wait);
                continue;
            }
            console.warn("[nick check] status API failed, assuming not nicked:", err.message);
            return false;
        }
    }
    return false;
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const POLL_INTERVAL_ACTIVE = 12000;
const POLL_INTERVAL_IDLE   = 20000;
const STAGGER_STEP         = 3000;
const NICK_CHECK_DELAY     = 15000;

// Finds an existing player entry by UUID (case-insensitive lookup helper)
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

    // Check if this player is already tracked (matched by UUID, regardless of input casing)
    const existingKey = findPlayerKeyByUUID(uuid);

    if (existingKey) {
        // Player already exists - just add the user to the tracker and the thread
        if (!data.players[existingKey].discordUsers.includes(userId)) {
            data.players[existingKey].discordUsers.push(userId);

            // Add user to the existing thread if it exists
            if (data.threads[existingKey]) {
                try {
                    const thread = await client.channels.fetch(data.threads[existingKey]);
                    await thread.members.add(userId);
                } catch {}
            }
        }
        saveData();
        return { success: true, canonicalName: existingKey };
    }

    // Brand-new player - store under the canonical Mojang username
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
    return { success: true, canonicalName };
}

async function removePlayer(inputUsername, userId) {
    // Resolve to canonical key: exact match first, then UUID lookup via Mojang
    let key = data.players[inputUsername] ? inputUsername : null;

    if (!key) {
        // Try a case-insensitive match against stored keys
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

                const streakBefore = prev[streakKey] ?? prev.winstreak ?? 0;
                const streakAfter  = cur[streakKey]  ?? cur.winstreak  ?? 0;
                const streakDiff   = streakAfter - streakBefore;

                const streakLine = streakAfter === 0
                    ? "Winstreak: reset to 0"
                    : "Winstreak: " + (streakDiff >= 0 ? "+" : "") + streakDiff + " (now " + streakAfter + ")";

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

                playerTimers[username] = setTimeout(() => pollPlayer(username), POLL_INTERVAL_IDLE);
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

            sleep(NICK_CHECK_DELAY).then(async () => {
                if (!data.players[username]) return;
                const nicked = await isPlayerNicked(player.uuid);
                if (nicked) {
                    try {
                        await startMsg.edit(
                            ":video_game: **" + username + "** started a **" + modeLabel + "** game\n" +
                            "Map: **" + latestGame.map + "**\n" +
                            ":disguised_face: Player appears to be **nicked**"
                        );
                    } catch {}
                }
            });

            playerTimers[username] = setTimeout(() => pollPlayer(username), POLL_INTERVAL_ACTIVE);
            return;
        }

    } catch (err) {
        const isRateLimit = err?.response?.status === 429;
        const retryAfter  = isRateLimit
            ? parseInt(err.response.headers["retry-after"] || "10000")
            : POLL_INTERVAL_IDLE;

        if (isRateLimit) {
            console.warn("[" + username + "] Rate limited - retrying in " + (retryAfter / 1000) + "s");
        } else {
            console.error("[" + username + "] Poll error:", err.message);
        }

        playerTimers[username] = setTimeout(() => pollPlayer(username), retryAfter);
        return;
    }

    playerTimers[username] = setTimeout(() => pollPlayer(username), POLL_INTERVAL_IDLE);
}

function startPollingPlayer(username, delay) {
    if (playerTimers[username]) clearTimeout(playerTimers[username]);
    playerTimers[username] = setTimeout(() => pollPlayer(username), delay);
}

client.once("clientReady", async () => {
    console.log("Logged in as " + client.user.tag);
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

    setTimeout(() => {
        botReady = true;
        console.log("Bot ready - thread sync active");
    }, 5000);
});

let botReady = false;

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

        const { success, canonicalName } = await addPlayer(inputUsername, userId);
        if (!success) return interaction.editReply("Could not find player **" + inputUsername + "**");

        await getOrCreateThread(canonicalName);
        return interaction.editReply("Now tracking **" + canonicalName + "**");
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
