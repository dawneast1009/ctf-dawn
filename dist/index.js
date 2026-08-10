"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const discord_js_1 = require("discord.js");
const store_1 = require("./store");
const core_1 = require("./ctf/core");
const platforms_1 = require("./ctf/platforms");
const secrets_1 = require("./ctf/secrets");
const token = process.env.DISCORD_TOKEN;
if (!token)
    throw new Error("DISCORD_TOKEN이 없습니다.");
const ownerId = process.env.BOT_OWNER_ID?.trim();
const guildIds = (process.env.GUILD_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const client = new discord_js_1.Client({ intents: [discord_js_1.GatewayIntentBits.Guilds] });
const solveDrafts = new Map();
const deleteDrafts = new Map();
const pullDrafts = new Map();
const threadOpenings = new Map();
const legacyStatusCleaned = new Set();
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const adminSubs = new Set(["create", "createchallenge", "edit", "delete", "deletechallenge", "addpoint", "deletepoint", "pull", "warning", "defaultsettings"]);
const command = new discord_js_1.SlashCommandBuilder().setName("ctf").setDescription("DAWN CTF workspace")
    .addSubcommand((s) => s.setName("create").setDescription("Create a CTF workspace").addStringOption((o) => o.setName("name").setDescription("CTF name").setRequired(true)).addStringOption((o) => o.setName("start").setDescription("KST YYYY-MM-DD HH:mm").setRequired(true)).addStringOption((o) => o.setName("end").setDescription("KST YYYY-MM-DD HH:mm").setRequired(true)).addStringOption((o) => o.setName("team").setDescription("External team name").setRequired(false)))
    .addSubcommand((s) => s.setName("createchallenge").setDescription("Create challenge here").addStringOption((o) => o.setName("category").setDescription("lowercase category").setRequired(true)).addStringOption((o) => o.setName("name").setDescription("challenge name").setRequired(true)))
    .addSubcommand((s) => s.setName("solve").setDescription("Record solver and contributors"))
    .addSubcommand((s) => s.setName("edit").setDescription("Edit current CTF").addStringOption((o) => o.setName("start").setDescription("new KST start")).addStringOption((o) => o.setName("end").setDescription("new KST end")).addStringOption((o) => o.setName("team").setDescription("team name")))
    .addSubcommand((s) => s.setName("delete").setDescription("Delete the current CTF workspace"))
    .addSubcommand((s) => s.setName("deletechallenge").setDescription("Delete a challenge"))
    .addSubcommand((s) => s.setName("addpoint").setDescription("Add score").addUserOption((o) => o.setName("user").setDescription("member").setRequired(true)).addStringOption((o) => o.setName("type").setDescription("type").setRequired(true).addChoices({ name: "Solve (1)", value: "1" }, { name: "Contribute (0.5)", value: "0.5" })))
    .addSubcommand((s) => s.setName("deletepoint").setDescription("Delete score").addUserOption((o) => o.setName("user").setDescription("member").setRequired(true)))
    .addSubcommand((s) => s.setName("history").setDescription("Your activity"))
    .addSubcommand((s) => s.setName("info").setDescription("Current CTF info"))
    .addSubcommand((s) => s.setName("leaderboard").setDescription("Contribution leaderboard"))
    .addSubcommand((s) => s.setName("profile").setDescription("Member profile").addUserOption((o) => o.setName("user").setDescription("member")))
    .addSubcommand((s) => s.setName("pull").setDescription("Pull CTFd/rCTF/HSPACE challenges"))
    .addSubcommand((s) => s.setName("warning").setDescription("Toggle monitor").addBooleanOption((o) => o.setName("enabled").setDescription("state").setRequired(true)))
    .addSubcommand((s) => s.setName("defaultsettings").setDescription("Show defaults"));
const core = [["general", "general"], ["bot", "bot-command"], ["announce", "📣｜announce"], ["credential", "🔑｜credential"], ["solve", "📃｜solve"], ["feed", "🤝｜feed"]];
async function channel(guild, contest, key, name) { const saved = (0, store_1.getChannel)(guild.id, `${contest.key}:${key}`); const old = saved ? await guild.channels.fetch(saved).catch(() => null) : null; if (old?.type === discord_js_1.ChannelType.GuildText)
    return old; const made = await guild.channels.create({ name, type: discord_js_1.ChannelType.GuildText, parent: contest.categoryId }); (0, store_1.putChannel)(guild.id, `${contest.key}:${key}`, made.id); return made; }
async function announcementChannel(guild) {
    const saved = (0, store_1.getChannel)(guild.id, "announcement");
    const old = saved ? await guild.channels.fetch(saved).catch(() => null) : null;
    if (old?.type === discord_js_1.ChannelType.GuildText)
        return old;
    const existing = guild.channels.cache.find((value) => value.type === discord_js_1.ChannelType.GuildText && value.name === "대회-알림");
    if (existing?.type === discord_js_1.ChannelType.GuildText) {
        (0, store_1.putChannel)(guild.id, "announcement", existing.id);
        return existing;
    }
    const made = await guild.channels.create({ name: "대회-알림", type: discord_js_1.ChannelType.GuildText, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [discord_js_1.PermissionFlagsBits.SendMessages] }, { id: guild.members.me.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages] }] });
    (0, store_1.putChannel)(guild.id, "announcement", made.id);
    return made;
}
async function ensureContestAnnouncement(guild, contest) {
    const announcements = await announcementChannel(guild);
    if (contest.lobbyChannelId === announcements.id && contest.lobbyMessageId) {
        const existing = await announcements.messages.fetch(contest.lobbyMessageId).catch(() => null);
        if (existing)
            return contest;
    }
    const message = await announcements.send({ content: `다음 대회: **${contest.name}**\n일정: <t:${Math.floor(contest.startsAt / 1000)}:f> ~ <t:${Math.floor(contest.endsAt / 1000)}:f>`, components: [new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`join:${contest.key}`).setLabel("참가할게").setEmoji("👋").setStyle(discord_js_1.ButtonStyle.Primary))] });
    return (0, store_1.patchContest)(guild.id, contest.key, { lobbyChannelId: announcements.id, lobbyMessageId: message.id });
}
async function deleteContestWorkspace(guild, contest) {
    const failures = [];
    const announcementId = (0, store_1.getChannel)(guild.id, "announcement");
    if (contest.lobbyChannelId && contest.lobbyMessageId) {
        const lobby = await guild.channels.fetch(contest.lobbyChannelId).catch(() => null);
        if (lobby?.type === discord_js_1.ChannelType.GuildText)
            await lobby.messages.delete(contest.lobbyMessageId).catch(() => undefined);
        if (lobby?.type === discord_js_1.ChannelType.GuildText && lobby.id !== announcementId && lobby.name === `dawn-${contest.key}`.slice(0, 95))
            await lobby.delete().catch(() => failures.push("이전 대회 알림 채널"));
    }
    for (const child of guild.channels.cache.filter((value) => value.parentId === contest.categoryId).values())
        await child.delete().catch(() => failures.push(`#${child.name}`));
    const category = await guild.channels.fetch(contest.categoryId).catch(() => null);
    if (category)
        await category.delete().catch(() => failures.push("대회 카테고리"));
    const role = await guild.roles.fetch(contest.roleId).catch(() => null);
    if (role)
        await role.delete().catch(() => failures.push("참가 역할"));
    if (failures.length)
        throw new Error(`삭제하지 못한 항목: ${failures.join(", ")}`);
    for (const [draftId, draft] of solveDrafts)
        if ((0, store_1.getProblem)(draft.problemId)?.ctfKey === contest.key)
            solveDrafts.delete(draftId);
    (0, store_1.removeContest)(guild.id, contest.key);
}
async function workspace(guild, name, startsAt, endsAt, teamName) {
    const key = (0, store_1.keyOf)(name);
    let role = (0, store_1.getContest)(guild.id, key)?.roleId ? await guild.roles.fetch((0, store_1.getContest)(guild.id, key).roleId).catch(() => null) : null;
    role ??= await guild.roles.create({ name: `CTF: ${name}` });
    let cat = (0, store_1.getContest)(guild.id, key)?.categoryId ? await guild.channels.fetch((0, store_1.getContest)(guild.id, key).categoryId).catch(() => null) : null;
    cat ??= await guild.channels.create({ name: `🚩 ${name}`.slice(0, 95), type: discord_js_1.ChannelType.GuildCategory, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] }, { id: role.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel] }, { id: guild.members.me.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.ManageChannels, discord_js_1.PermissionFlagsBits.ManageThreads, discord_js_1.PermissionFlagsBits.SendMessages] }] });
    const old = (0, store_1.getContest)(guild.id, key);
    let contest = old ? { ...old, name, roleId: role.id, categoryId: cat.id, startsAt, endsAt, teamName: teamName ?? old.teamName, updatedAt: Date.now() } : { guildId: guild.id, key, name, roleId: role.id, categoryId: cat.id, startsAt, endsAt, teamName, allSolved: false, warningEnabled: false, createdAt: Date.now(), updatedAt: Date.now() };
    (0, store_1.putContest)(contest);
    for (const [k, n] of core)
        await channel(guild, contest, k, n);
    return ensureContestAnnouncement(guild, contest);
}
function current(i) { const p = (0, store_1.getProblemByThread)(i.channelId); if (p)
    return (0, store_1.getContest)(i.guildId, p.ctfKey); const parent = i.channel && "parentId" in i.channel ? i.channel.parentId : null; return (0, store_1.getContests)(i.guildId).find((c) => c.categoryId === parent || c.categoryId === i.channelId); }
async function syncCategoryChannels(guild, c) {
    const byCategory = new Map();
    for (const problem of (0, store_1.getProblems)(guild.id, c.key)) {
        const problems = byCategory.get(problem.genreKey) ?? [];
        problems.push(problem);
        byCategory.set(problem.genreKey, problems);
    }
    for (const [category, problems] of byCategory) {
        const saved = (0, store_1.getChannel)(guild.id, `${c.key}:genre:${category}`);
        const genreChannel = saved ? await guild.channels.fetch(saved).catch(() => null) : null;
        const expected = (0, core_1.categoryChannelName)(category, problems);
        if (genreChannel?.type === discord_js_1.ChannelType.GuildText && genreChannel.name !== expected)
            await genreChannel.setName(expected);
    }
}
function challengeCardPayload(problem) {
    const solver = Object.entries(problem.scores).find(([, score]) => score >= 1)?.[0];
    const participants = new Set(problem.participants ?? []);
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`${problem.solved ? "✅" : "❌"} ${problem.name}`)
        .setColor(problem.solved ? 0x2ecc71 : 0xf1c40f)
        .setDescription(problem.solved ? `solved by ${solver ? `<@${solver}>` : "기록된 팀원"}` : `${participants.size}명 참여중`);
    const button = new discord_js_1.ButtonBuilder()
        .setCustomId(`challenge-open:${problem.id}`)
        .setLabel(problem.solved ? "이미 풀렸긴 한데... 구경할래요 🥺" : "이거 풀래요")
        .setStyle(discord_js_1.ButtonStyle.Secondary);
    if (!problem.solved)
        button.setEmoji("👋");
    return { embeds: [embed], components: [new discord_js_1.ActionRowBuilder().addComponents(button)] };
}
function solveDraftPayload(draftId, draft, problem, solverPicker = false, content) {
    const contributors = draft.helpers.length ? draft.helpers.map((userId) => `<@${userId}>`).join(", ") : "없음";
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`🔧 ${problem.name} — Solve`)
        .setColor(0x00c9a7)
        .setDescription(`**Main Solver:** <@${draft.solver}>\n**Contributors:** ${contributors}\n**Flag:** ${draft.flag ? (0, discord_js_1.inlineCode)(draft.flag) : "미입력"}`);
    if (solverPicker) {
        return {
            content: content ?? "메인 Solver를 선택하세요.",
            embeds: [embed],
            components: [new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.UserSelectMenuBuilder().setCustomId(`solve-solver:${draftId}`).setPlaceholder("Main Solver 선택").setMinValues(1).setMaxValues(1).setDefaultUsers(draft.solver))],
        };
    }
    const contributorsSelect = new discord_js_1.UserSelectMenuBuilder().setCustomId(`solve-helpers:${draftId}`).setPlaceholder("같이 푼 사람 선택").setMinValues(0).setMaxValues(10);
    if (draft.helpers.length)
        contributorsSelect.setDefaultUsers(...draft.helpers);
    return {
        content: content ?? "같이 푼 사람 선택",
        embeds: [embed],
        components: [
            new discord_js_1.ActionRowBuilder().addComponents(contributorsSelect),
            new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`solve-flag:${draftId}`).setLabel("Flag 입력").setEmoji("🚩").setStyle(discord_js_1.ButtonStyle.Secondary), new discord_js_1.ButtonBuilder().setCustomId(`solve-change:${draftId}`).setLabel("Solver 변경").setEmoji("🧍").setStyle(discord_js_1.ButtonStyle.Secondary), new discord_js_1.ButtonBuilder().setCustomId(`solve-submit:${draftId}`).setLabel("Submit").setEmoji("📥").setStyle(discord_js_1.ButtonStyle.Success)),
        ],
    };
}
function activeSolveDraft(draftId, userId) {
    const draft = solveDrafts.get(draftId);
    if (!draft || draft.ownerId !== userId || Date.now() - draft.createdAt > 10 * 60_000)
        return null;
    return draft;
}
async function ensureChallengeCard(guild, problem) {
    const genreChannel = await guild.channels.fetch(problem.channelId).catch(() => null);
    if (genreChannel?.type !== discord_js_1.ChannelType.GuildText)
        throw new Error("문제 분야 채널을 찾을 수 없습니다.");
    if (problem.cardMessageId) {
        const old = await genreChannel.messages.fetch(problem.cardMessageId).catch(() => null);
        if (old)
            return old;
    }
    const card = await genreChannel.send(challengeCardPayload(problem));
    (0, store_1.patchProblem)(problem.id, { cardMessageId: card.id });
    return card;
}
async function refreshChallengeCard(guild, problem) {
    const latest = (0, store_1.getProblem)(problem.id) ?? problem;
    const card = await ensureChallengeCard(guild, latest);
    await card.edit(challengeCardPayload(latest));
    if (latest.threadId) {
        const thread = await guild.channels.fetch(latest.threadId).catch(() => null);
        const expected = `${latest.solved ? "✅" : "❌"}｜${latest.name}`.slice(0, 100);
        if (thread?.isThread() && thread.name !== expected)
            await thread.setName(expected);
    }
}
async function ensureChallengeThread(guild, problemId) {
    const running = threadOpenings.get(problemId);
    if (running)
        return running;
    const opening = (async () => {
        const problem = (0, store_1.getProblem)(problemId);
        if (!problem)
            throw new Error("문제를 찾을 수 없습니다.");
        if (problem.threadId) {
            const old = await guild.channels.fetch(problem.threadId).catch(() => null);
            if (old?.isThread())
                return old;
        }
        const genreChannel = await guild.channels.fetch(problem.channelId).catch(() => null);
        if (genreChannel?.type !== discord_js_1.ChannelType.GuildText)
            throw new Error("문제 분야 채널을 찾을 수 없습니다.");
        const thread = await genreChannel.threads.create({ name: `❌｜${problem.name}`.slice(0, 100), type: discord_js_1.ChannelType.PrivateThread, invitable: true, autoArchiveDuration: discord_js_1.ThreadAutoArchiveDuration.OneWeek });
        (0, store_1.patchProblem)(problem.id, { threadId: thread.id });
        await thread.send(`**${problem.name}** · ${problem.genre}\n이 스레드에서 \`/ctf solve\`를 사용하세요.`);
        return thread;
    })();
    threadOpenings.set(problemId, opening);
    try {
        return await opening;
    }
    finally {
        threadOpenings.delete(problemId);
    }
}
async function ensureChallengeCards(guild, contest) {
    for (const problem of (0, store_1.getProblems)(guild.id, contest.key))
        await refreshChallengeCard(guild, problem);
}
function categorySummaryEmbed(category, problems) {
    const solved = problems.filter((problem) => problem.solved);
    const lines = problems.map((problem) => {
        if (!problem.solved)
            return `⬜ ${problem.name}`;
        const solver = Object.entries(problem.scores).find(([, score]) => score >= 1)?.[0];
        return `✅ ${problem.name}${solver ? ` — solved by <@${solver}>` : ""}`;
    });
    let body = "";
    for (const line of lines) {
        if (body.length + line.length > 3700) {
            body += "\n…";
            break;
        }
        body += `${body ? "\n" : ""}${line}`;
    }
    const allSolved = (0, core_1.isAllSolved)(problems);
    const title = category.charAt(0).toUpperCase() + category.slice(1);
    return new discord_js_1.EmbedBuilder().setTitle(`${allSolved ? "🟦" : "⬜"} ${title}`).setColor(allSolved ? 0x3498db : 0xffffff).setDescription(`${body || "등록된 문제 없음"}\n\n**${solved.length}/${problems.length} solved**`);
}
async function cleanupLegacyStatus(guild, contest, solveChannel) {
    const cleanupKey = `${guild.id}:${contest.key}`;
    if (legacyStatusCleaned.has(cleanupKey))
        return;
    legacyStatusCleaned.add(cleanupKey);
    const messages = await solveChannel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages)
        return;
    for (const message of messages.values()) {
        const title = message.embeds[0]?.title ?? "";
        if (message.author.id === client.user.id && (title === `⚪ ${contest.name}` || title === `🔵 ALL SOLVE · ${contest.name}`))
            await message.delete().catch(() => undefined);
    }
}
async function status(guild, contest) {
    const problems = (0, store_1.getProblems)(guild.id, contest.key);
    (0, store_1.patchContest)(guild.id, contest.key, { allSolved: (0, core_1.isAllSolved)(problems) });
    await syncCategoryChannels(guild, contest);
    const solveChannel = await channel(guild, contest, "solve", "📃｜solve");
    await cleanupLegacyStatus(guild, contest, solveChannel);
    const announceChannel = await channel(guild, contest, "announce", "📣｜announce");
    const byCategory = new Map();
    for (const problem of problems)
        byCategory.set(problem.genreKey, [...(byCategory.get(problem.genreKey) ?? []), problem]);
    const activeSummaryKeys = new Set([...byCategory.keys()].map((category) => `${contest.key}:summary:${category}`));
    for (const saved of (0, store_1.getMessages)(guild.id, `${contest.key}:summary:`))
        if (!activeSummaryKeys.has(saved.key)) {
            await announceChannel.messages.delete(saved.id).catch(() => undefined);
            (0, store_1.removeMessage)(guild.id, saved.key);
        }
    for (const [category, categoryProblems] of byCategory) {
        const messageKey = `${contest.key}:summary:${category}`;
        const saved = (0, store_1.getMessage)(guild.id, messageKey);
        const old = saved ? await announceChannel.messages.fetch(saved).catch(() => null) : null;
        const payload = { embeds: [categorySummaryEmbed(category, categoryProblems)] };
        if (old)
            await old.edit(payload);
        else {
            const message = await announceChannel.send(payload);
            (0, store_1.putMessage)(guild.id, messageKey, message.id);
        }
    }
}
async function challenge(guild, c, category, name, externalId, updateStatus = true) { if ((0, store_1.findProblem)(guild.id, c.key, name))
    return; const genre = (0, core_1.normalizeCtfCategory)(category); const ch = await channel(guild, c, `genre:${genre}`, `⬜｜${genre}`); const problem = { id: id(), guildId: guild.id, ctfName: c.name, ctfKey: c.key, name, nameKey: (0, store_1.keyOf)(name), genre, genreKey: genre, channelId: ch.id, authorId: client.user.id, participants: [], scores: {}, solved: false, externalId, createdAt: Date.now() }; (0, store_1.putProblem)(problem); try {
    await ensureChallengeCard(guild, problem);
}
catch (error) {
    (0, store_1.removeProblem)(problem.id);
    throw error;
} if (updateStatus)
    await status(guild, c); return (0, store_1.getProblem)(problem.id); }
client.once(discord_js_1.Events.ClientReady, async () => { for (const g of client.guilds.cache.values())
    if (!guildIds.length || guildIds.includes(g.id)) {
        await g.commands.set([command.toJSON()]);
        for (const c of (0, store_1.getContests)(g.id)) {
            await ensureContestAnnouncement(g, c);
            await ensureChallengeCards(g, c);
            await status(g, c);
        }
    } console.log(`DAWN online: ${client.user.tag}`); });
client.on(discord_js_1.Events.InteractionCreate, async (i) => { try {
    if (i.isChatInputCommand())
        await handle(i);
    else if (i.isButton())
        await button(i);
    else if (i.isModalSubmit() && i.customId.startsWith("ctf-pull:"))
        await pullModal(i);
    else if (i.isModalSubmit() && i.customId.startsWith("solve-flag:"))
        await solveFlagModal(i);
    else if (i.isUserSelectMenu() && (i.customId.startsWith("solve-helpers:") || i.customId.startsWith("solve-solver:")))
        await solveSelect(i);
    else if (i.isStringSelectMenu())
        await select(i.customId, i.values[0], i);
}
catch (e) {
    console.error(e);
    if (i.isRepliable() && !i.replied && !i.deferred)
        await i.reply({ content: "처리 중 오류가 발생했습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
} });
async function handle(i) {
    if (!i.guild)
        return;
    const sub = i.options.getSubcommand();
    if (adminSubs.has(sub) && i.user.id !== (ownerId || i.guild.ownerId))
        return void await i.reply({ content: "봇 소유자 전용입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    const c = current(i);
    if (sub === "create") {
        const s = (0, core_1.parseKstDateTime)(i.options.getString("start", true)), e = (0, core_1.parseKstDateTime)(i.options.getString("end", true));
        if (!s || !e || e <= s)
            return void await i.reply({ content: "KST YYYY-MM-DD HH:mm 형식을 확인하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        await i.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        const made = await workspace(i.guild, i.options.getString("name", true), s, e, i.options.getString("team") ?? undefined);
        return void await i.editReply(`생성 완료: <#${made.categoryId}>`);
    }
    if (sub === "createchallenge") {
        if (!c)
            return void await i.reply({ content: "CTF 카테고리 안에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        await i.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        const p = await challenge(i.guild, c, i.options.getString("category", true), i.options.getString("name", true));
        return void await i.editReply(p ? `<#${p.channelId}>에 문제 카드 생성 완료` : "중복 문제입니다.");
    }
    if (sub === "solve") {
        const p = (0, store_1.getProblemByThread)(i.channelId);
        if (!p || p.solved)
            return void await i.reply({ content: p ? "이미 풀린 문제입니다." : "문제 스레드에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const draftId = id(), draft = { problemId: p.id, ownerId: i.user.id, solver: i.user.id, helpers: [], createdAt: Date.now() };
        solveDrafts.set(draftId, draft);
        return void await i.reply({ ...solveDraftPayload(draftId, draft, p), flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "delete") {
        if (!c)
            return void await i.reply({ content: "삭제할 CTF 공간 안에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const confirmationId = id();
        deleteDrafts.set(confirmationId, { guildId: i.guild.id, ctfKey: c.key, userId: i.user.id, createdAt: Date.now() });
        return void await i.reply({ content: `**${c.name}**의 채널, 문제, 점수 기록과 참가 역할을 모두 삭제할까요?`, components: [new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`delete-contest:${confirmationId}`).setLabel("CTF 삭제 확인").setStyle(discord_js_1.ButtonStyle.Danger))], flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "info" && c)
        return void await i.reply({ embeds: [new discord_js_1.EmbedBuilder().setTitle(c.name).setDescription(`<t:${Math.floor(c.startsAt / 1000)}:f> ~ <t:${Math.floor(c.endsAt / 1000)}:f>\n${(0, store_1.getProblems)(i.guild.id, c.key).length} challenges`)] });
    if (sub === "edit" && c) {
        const start = i.options.getString("start"), end = i.options.getString("end");
        const s = start ? (0, core_1.parseKstDateTime)(start) : c.startsAt, e = end ? (0, core_1.parseKstDateTime)(end) : c.endsAt;
        if (!s || !e || e <= s)
            return void await i.reply({ content: "KST 일정을 확인하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        (0, store_1.patchContest)(i.guild.id, c.key, { startsAt: s, endsAt: e, teamName: i.options.getString("team") ?? c.teamName });
        return void await i.reply({ content: "CTF 정보 수정 완료", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "profile" || sub === "history") {
        const u = sub === "profile" ? i.options.getUser("user") ?? i.user : i.user;
        const rows = (0, store_1.getProblems)(i.guild.id).filter((p) => p.scores[u.id] != null);
        return void await i.reply({ embeds: [new discord_js_1.EmbedBuilder().setTitle(`${u.username} · ${rows.reduce((n, p) => n + p.scores[u.id], 0)}점`).setDescription(rows.map((p) => `${p.scores[u.id] === 1 ? "✅" : "🤝"} ${p.ctfName}/${p.name}`).join("\n") || "기록 없음")] });
    }
    if (sub === "leaderboard") {
        const totals = new Map();
        for (const p of (0, store_1.getProblems)(i.guild.id))
            for (const [u, n] of Object.entries(p.scores))
                totals.set(u, (totals.get(u) ?? 0) + n);
        return void await i.reply([...totals.entries()].sort((a, b) => b[1] - a[1]).map(([u, n], x) => `${x + 1}. <@${u}> · ${n}`).join("\n") || "기록 없음");
    }
    if (sub === "pull") {
        if (!c)
            return void await i.reply({ content: "CTF 공간 안에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const pullId = id();
        pullDrafts.set(pullId, { guildId: i.guild.id, ctfKey: c.key, userId: i.user.id, createdAt: Date.now() });
        const modal = new discord_js_1.ModalBuilder().setCustomId(`ctf-pull:${pullId}`).setTitle("CTF 문제 가져오기").addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("url").setLabel("대회 주소").setPlaceholder("https://forge.hspace.io/competitions/...").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("access-token").setLabel("Access-Token (공개 대회는 비워두기)").setStyle(discord_js_1.TextInputStyle.Paragraph).setRequired(false)));
        return void await i.showModal(modal);
    }
    if (sub === "warning" && c) {
        (0, store_1.patchContest)(i.guild.id, c.key, { warningEnabled: i.options.getBoolean("enabled", true) });
        return void await i.reply({ content: "변경 완료", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "defaultsettings")
        return void await i.reply({ content: "KST · Solve 1 · Contribute 0.5 · monitor 120s", flags: discord_js_1.MessageFlags.Ephemeral });
    if (["deletechallenge", "addpoint", "deletepoint"].includes(sub)) {
        const ps = (0, store_1.getProblems)(i.guild.id, c?.key);
        const menu = new discord_js_1.StringSelectMenuBuilder().setCustomId(`${sub}:${i.options.getUser("user")?.id ?? ""}:${i.options.getString("type") ?? ""}`).setPlaceholder("문제 선택").addOptions(ps.slice(0, 25).map(p => ({ label: p.name, value: p.id })));
        return void await i.reply({ content: "문제를 선택하세요.", components: [new discord_js_1.ActionRowBuilder().addComponents(menu)], flags: discord_js_1.MessageFlags.Ephemeral });
    }
}
async function pullModal(i) { const pullId = i.customId.slice(9), draft = pullDrafts.get(pullId); pullDrafts.delete(pullId); if (!i.guild || !draft || draft.guildId !== i.guild.id || draft.userId !== i.user.id || Date.now() - draft.createdAt > 300_000)
    return void await i.reply({ content: "Pull 입력 창이 만료되었습니다. `/ctf pull`을 다시 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral }); const c = (0, store_1.getContest)(i.guild.id, draft.ctfKey); if (!c)
    return void await i.reply({ content: "CTF 공간을 찾을 수 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral }); await i.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral }); try {
    const url = i.fields.getTextInputValue("url").trim().replace(/\/+$/, "");
    const accessToken = i.fields.getTextInputValue("access-token").trim();
    const encryptedAccessToken = accessToken ? (0, secrets_1.encryptSecret)(accessToken) : undefined;
    let platform = await (0, platforms_1.detectPlatform)(url), list;
    if (platform === "hspace")
        list = await (0, platforms_1.fetchPublicChallenges)(platform, url, accessToken);
    else if (accessToken) {
        const result = await (0, platforms_1.fetchChallengesWithToken)(url, accessToken);
        platform = result.platform;
        list = result.challenges;
    }
    else {
        if (platform === "generic")
            return void await i.editReply("지원되는 CTFd/rCTF/HSPACE 주소가 아닙니다.");
        list = await (0, platforms_1.fetchPublicChallenges)(platform, url);
    }
    const ongoing = c.endsAt > Date.now();
    (0, store_1.patchContest)(i.guild.id, c.key, { platform, sourceUrl: url, publicApiReadable: ongoing, encryptedAccessToken: ongoing ? encryptedAccessToken : undefined });
    let n = 0;
    for (const x of list)
        if (await challenge(i.guild, c, x.category, x.name, x.externalId, false))
            n++;
    if (n)
        await status(i.guild, c);
    const tokenMessage = accessToken ? (ongoing ? "\nAccess-Token을 암호화해 이 대회의 자동 감시에 저장했습니다." : "\n종료된 대회라 Access-Token은 저장하지 않았습니다.") : "";
    return void await i.editReply(`${list.length}개 확인 · ${n}개 문제 추가${tokenMessage}`);
}
catch (error) {
    return void await i.editReply(`Pull 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
} }
async function solveSelect(i) {
    const solverMode = i.customId.startsWith("solve-solver:");
    const draftId = i.customId.slice(solverMode ? 13 : 14);
    const draft = activeSolveDraft(draftId, i.user.id);
    const problem = draft && (0, store_1.getProblem)(draft.problemId);
    if (!draft || !problem)
        return void await i.update({ content: "Solve 입력이 만료되었습니다. `/ctf solve`를 다시 실행하세요.", embeds: [], components: [] });
    if (solverMode) {
        draft.solver = i.values[0];
        draft.helpers = draft.helpers.filter((userId) => userId !== draft.solver);
    }
    else
        draft.helpers = i.values.filter((userId) => userId !== draft.solver);
    await i.update(solveDraftPayload(draftId, draft, problem));
}
async function solveFlagModal(i) {
    const draftId = i.customId.slice(11);
    const draft = activeSolveDraft(draftId, i.user.id);
    const problem = draft && (0, store_1.getProblem)(draft.problemId);
    if (!draft || !problem)
        return void await i.reply({ content: "Solve 입력이 만료되었습니다. `/ctf solve`를 다시 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
    draft.flag = i.fields.getTextInputValue("flag").trim();
    if (i.isFromMessage())
        await i.update(solveDraftPayload(draftId, draft, problem));
    else
        await i.reply({ ...solveDraftPayload(draftId, draft, problem), flags: discord_js_1.MessageFlags.Ephemeral });
}
async function submitSolve(i, draftId) {
    const draft = activeSolveDraft(draftId, i.user.id);
    const problem = draft && (0, store_1.getProblem)(draft.problemId);
    if (!draft || !problem)
        return void await i.update({ content: "Solve 입력이 만료되었습니다. `/ctf solve`를 다시 실행하세요.", embeds: [], components: [] });
    if (problem.solved)
        return void await i.update({ content: "이미 풀린 문제입니다.", embeds: [], components: [] });
    if (!draft.flag)
        return void await i.update(solveDraftPayload(draftId, draft, problem, false, "먼저 Flag를 입력하세요."));
    const scores = { [draft.solver]: 1 };
    for (const helper of draft.helpers)
        if (helper !== draft.solver)
            scores[helper] = 0.5;
    (0, store_1.patchProblem)(problem.id, { scores, solved: true, submittedFlag: draft.flag });
    const updated = (0, store_1.getProblem)(problem.id);
    await refreshChallengeCard(i.guild, updated);
    const contributors = draft.helpers.length ? draft.helpers.map((userId) => `<@${userId}>`).join(", ") : "없음";
    const solveEmbed = new discord_js_1.EmbedBuilder().setTitle("🎉 Challenge solved!").setColor(0xff9f1c).setDescription(`**${problem.name}** [${problem.genre}]\n\n**Flag found by:** <@${draft.solver}>\n**Contributors:** ${contributors}\n**Flag submitter:** <@${draft.ownerId}>\n**Submitted flag:** ${(0, discord_js_1.inlineCode)(draft.flag)}`).setTimestamp();
    const solverMember = await i.guild.members.fetch(draft.solver).catch(() => null);
    if (solverMember)
        solveEmbed.setThumbnail(solverMember.displayAvatarURL({ size: 256 }));
    const thread = updated.threadId ? await i.guild.channels.fetch(updated.threadId).catch(() => null) : null;
    if (thread?.isThread())
        await thread.send({ embeds: [solveEmbed] });
    const contest = (0, store_1.getContest)(i.guild.id, problem.ctfKey);
    const solveChannel = await channel(i.guild, contest, "solve", "📃｜solve");
    await solveChannel.send({ content: `<@&${contest.roleId}>`, embeds: [solveEmbed], allowedMentions: { roles: [contest.roleId] } });
    await status(i.guild, contest);
    solveDrafts.delete(draftId);
    await i.update({ content: "Solve 기록 완료", embeds: [], components: [] });
}
async function button(i) {
    if (i.customId.startsWith("join:") && i.guild) {
        const contest = (0, store_1.getContest)(i.guild.id, i.customId.slice(5));
        if (!contest)
            return void await i.reply({ content: "삭제되었거나 만료된 대회입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const member = i.member;
        if (member.roles.cache.has(contest.roleId))
            return void await i.reply({ content: "이미 참가 중입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await member.roles.add(contest.roleId);
        const general = await channel(i.guild, contest, "general", "general");
        await general.send({ content: `<@${i.user.id}> 님이 참가했어 ⚔️`, allowedMentions: { users: [i.user.id] } });
        return void await i.reply({ content: "참가 완료", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (i.customId.startsWith("challenge-open:") && i.guild) {
        const problem = (0, store_1.getProblem)(i.customId.slice(15));
        if (!problem)
            return void await i.reply({ content: "삭제된 문제입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await i.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        try {
            const thread = await ensureChallengeThread(i.guild, problem.id);
            if (thread.archived)
                await thread.setArchived(false);
            await thread.members.add(i.user.id);
            const latest = (0, store_1.getProblem)(problem.id);
            if (!(latest.participants ?? []).includes(i.user.id))
                (0, store_1.patchProblem)(problem.id, { participants: [...(latest.participants ?? []), i.user.id] });
            await refreshChallengeCard(i.guild, (0, store_1.getProblem)(problem.id));
            return void await i.editReply(`<#${thread.id}> 스레드로 이동하세요.`);
        }
        catch (error) {
            return void await i.editReply(`스레드 생성 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
        }
    }
    if (i.customId.startsWith("solve-flag:")) {
        const draftId = i.customId.slice(11), draft = activeSolveDraft(draftId, i.user.id);
        if (!draft)
            return void await i.update({ content: "Solve 입력이 만료되었습니다.", embeds: [], components: [] });
        const input = new discord_js_1.TextInputBuilder().setCustomId("flag").setLabel("Flag").setPlaceholder("flag{...}").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true).setMaxLength(1000);
        if (draft.flag)
            input.setValue(draft.flag);
        return void await i.showModal(new discord_js_1.ModalBuilder().setCustomId(`solve-flag:${draftId}`).setTitle("Flag 입력").addComponents(new discord_js_1.ActionRowBuilder().addComponents(input)));
    }
    if (i.customId.startsWith("solve-change:")) {
        const draftId = i.customId.slice(13), draft = activeSolveDraft(draftId, i.user.id), problem = draft && (0, store_1.getProblem)(draft.problemId);
        if (!draft || !problem)
            return void await i.update({ content: "Solve 입력이 만료되었습니다.", embeds: [], components: [] });
        return void await i.update(solveDraftPayload(draftId, draft, problem, true));
    }
    if (i.customId.startsWith("solve-submit:"))
        return submitSolve(i, i.customId.slice(13));
    if (i.customId.startsWith("delete-contest:") && i.guild) {
        const confirmationId = i.customId.slice(15), draft = deleteDrafts.get(confirmationId);
        if (!draft || draft.guildId !== i.guild.id || draft.userId !== i.user.id || Date.now() - draft.createdAt > 300_000)
            return void await i.update({ content: "삭제 확인이 만료되었습니다. `/ctf delete`를 다시 실행하세요.", components: [] });
        const c = (0, store_1.getContest)(i.guild.id, draft.ctfKey);
        deleteDrafts.delete(confirmationId);
        if (!c)
            return void await i.update({ content: "이미 삭제된 CTF입니다.", components: [] });
        await i.update({ content: `**${c.name}** 삭제 중...`, components: [] });
        try {
            await deleteContestWorkspace(i.guild, c);
            await i.editReply({ content: `**${c.name}** 삭제 완료`, components: [] });
        }
        catch (error) {
            await i.editReply({ content: `삭제가 일부 완료되지 않았습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`, components: [] });
        }
    }
}
async function select(custom, pid, i) { const [kind, user, amount] = custom.split(":"); const p = (0, store_1.getProblem)(pid); if (!p)
    return; if (kind === "deletechallenge") {
    if (p.threadId)
        await i.guild.channels.delete(p.threadId).catch(() => undefined);
    if (p.cardMessageId) {
        const ch = await i.guild.channels.fetch(p.channelId).catch(() => null);
        if (ch?.type === discord_js_1.ChannelType.GuildText)
            await ch.messages.delete(p.cardMessageId).catch(() => undefined);
    }
    (0, store_1.removeProblem)(pid);
    const genreChannel = await i.guild.channels.fetch(p.channelId).catch(() => null);
    if (genreChannel?.type === discord_js_1.ChannelType.GuildText)
        await genreChannel.setName((0, core_1.categoryChannelName)(p.genreKey, (0, store_1.getProblems)(i.guild.id, p.ctfKey).filter(problem => problem.genreKey === p.genreKey)));
}
else if (kind === "addpoint") {
    (0, store_1.patchProblem)(pid, { scores: { ...p.scores, [user]: Number(amount) }, solved: Number(amount) === 1 || p.solved });
    await refreshChallengeCard(i.guild, (0, store_1.getProblem)(pid));
}
else if (kind === "deletepoint") {
    const s = { ...p.scores };
    delete s[user];
    (0, store_1.patchProblem)(pid, { scores: s, solved: Object.values(s).some(n => n >= 1) });
    await refreshChallengeCard(i.guild, (0, store_1.getProblem)(pid));
} await status(i.guild, (0, store_1.getContest)(i.guild.id, p.ctfKey)); await i.update({ content: "완료", components: [] }); }
async function monitorContests() {
    const now = Date.now();
    for (const guild of client.guilds.cache.values())
        for (const contest of (0, store_1.getContests)(guild.id)) {
            if (contest.endsAt <= now) {
                if (contest.warningEnabled || contest.publicApiReadable || contest.encryptedAccessToken)
                    (0, store_1.patchContest)(guild.id, contest.key, { warningEnabled: false, publicApiReadable: false, encryptedAccessToken: undefined });
                continue;
            }
            if (!contest.warningEnabled || !contest.publicApiReadable || !contest.platform || !contest.sourceUrl)
                continue;
            try {
                const accessToken = contest.encryptedAccessToken ? (0, secrets_1.decryptSecret)(contest.encryptedAccessToken) : undefined;
                let added = 0;
                for (const remote of await (0, platforms_1.fetchPublicChallenges)(contest.platform, contest.sourceUrl, accessToken))
                    if (await challenge(guild, contest, remote.category, remote.name, remote.externalId, false))
                        added++;
                if (added)
                    await status(guild, contest);
            }
            catch { /* 다음 주기에 다시 시도 */ }
        }
}
setInterval(monitorContests, Math.max(60, Number(process.env.CTF_MONITOR_INTERVAL_SECONDS) || 120) * 1000).unref();
client.login(token);
