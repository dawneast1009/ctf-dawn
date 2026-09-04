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
const challengeDetailCursors = new Map();
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const adminSubs = new Set(["create", "createchallenge", "edit", "delete", "deletechallenge", "addpoint", "deletepoint", "pull", "warning", "defaultsettings"]);
function pruneExpiredDrafts() {
    const now = Date.now();
    for (const [draftId, draft] of solveDrafts)
        if (now - draft.createdAt > 10 * 60_000)
            solveDrafts.delete(draftId);
    for (const [draftId, draft] of deleteDrafts)
        if (now - draft.createdAt > 5 * 60_000)
            deleteDrafts.delete(draftId);
    for (const [draftId, draft] of pullDrafts)
        if (now - draft.createdAt > 5 * 60_000)
            pullDrafts.delete(draftId);
}
setInterval(pruneExpiredDrafts, 5 * 60_000).unref();
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
    const payload = { content: `다음 대회: **${contest.name}**\n일정: <t:${Math.floor(contest.startsAt / 1000)}:f> ~ <t:${Math.floor(contest.endsAt / 1000)}:f>`, components: [new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`join:${contest.key}`).setLabel("참가할게").setEmoji("👋").setStyle(discord_js_1.ButtonStyle.Primary))] };
    if (contest.lobbyChannelId === announcements.id && contest.lobbyMessageId) {
        const existing = await announcements.messages.fetch(contest.lobbyMessageId).catch(() => null);
        if (existing) {
            await existing.edit(payload);
            return contest;
        }
    }
    const message = await announcements.send(payload);
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
    const roleName = name.trim().slice(0, 100);
    if (role && role.name !== roleName)
        await role.setName(roleName);
    role ??= await guild.roles.create({ name: roleName });
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
    if (!draft || draft.ownerId !== userId)
        return null;
    if (Date.now() - draft.createdAt > 10 * 60_000) {
        solveDrafts.delete(draftId);
        return null;
    }
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
async function deleteRemoteMessages(guild, channelId, messageIds) {
    if (!messageIds.length)
        return;
    const remoteChannel = await guild.channels.fetch(channelId).catch(() => null);
    if (remoteChannel?.type !== discord_js_1.ChannelType.GuildText)
        return;
    for (const messageId of messageIds)
        await remoteChannel.messages.delete(messageId).catch(() => undefined);
}
async function replaceRemoteDescription(guild, problem, description) {
    const target = await guild.channels.fetch(problem.channelId).catch(() => null);
    if (target?.type !== discord_js_1.ChannelType.GuildText)
        throw new Error("문제 분야 채널을 찾을 수 없습니다.");
    const created = [];
    try {
        for (const [index, chunk] of (0, core_1.splitChallengeDescription)(description).entries()) {
            const embed = new discord_js_1.EmbedBuilder().setColor(0x5865f2).setDescription(chunk);
            if (index === 0)
                embed.setTitle(`📖 ${problem.name} · 문제 설명`);
            const message = await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
            created.push(message.id);
        }
    }
    catch (error) {
        await deleteRemoteMessages(guild, problem.channelId, created);
        throw error;
    }
    await deleteRemoteMessages(guild, problem.descriptionChannelId ?? problem.channelId, problem.descriptionMessageIds ?? []);
    (0, store_1.patchProblem)(problem.id, { remoteDescription: description, descriptionMessageIds: created, descriptionChannelId: problem.channelId });
}
async function replaceRemoteFiles(guild, contest, problem, remote, auth) {
    if (remote.files === undefined)
        return;
    const target = await guild.channels.fetch(problem.channelId).catch(() => null);
    if (target?.type !== discord_js_1.ChannelType.GuildText)
        throw new Error("문제 분야 채널을 찾을 수 없습니다.");
    const moved = problem.fileChannelId != null && problem.fileChannelId !== problem.channelId;
    const previousMessages = problem.fileMessageIds ?? {};
    const nextMessages = {};
    const created = [];
    try {
        for (const file of remote.files) {
            const unchanged = (problem.remoteFiles ?? []).some((old) => old.id === file.id && old.name === file.name);
            if (!moved && unchanged && previousMessages[file.id]) {
                nextMessages[file.id] = previousMessages[file.id];
                continue;
            }
            let message;
            try {
                const downloaded = await (0, platforms_1.downloadRemoteChallengeFile)(contest.sourceUrl, file, auth);
                message = await target.send({ content: `📎 **${file.name}**`, files: [new discord_js_1.AttachmentBuilder(downloaded.data, { name: downloaded.name })], allowedMentions: { parse: [] } });
            }
            catch (error) {
                if (!(error instanceof Error) || error.message !== "FILE_TOO_LARGE")
                    throw error;
                message = await target.send({ content: `📎 **${file.name}** · Discord 업로드 한도를 초과했습니다. CTFd 문제 페이지에서 직접 내려받으세요.`, allowedMentions: { parse: [] } });
            }
            created.push(message.id);
            nextMessages[file.id] = message.id;
        }
    }
    catch (error) {
        await deleteRemoteMessages(guild, problem.channelId, created);
        throw error;
    }
    const retained = new Set(Object.values(nextMessages));
    const obsolete = Object.values(previousMessages).filter((messageId) => !retained.has(messageId));
    await deleteRemoteMessages(guild, problem.fileChannelId ?? problem.channelId, obsolete);
    (0, store_1.patchProblem)(problem.id, {
        remoteFiles: remote.files.map(({ id: fileId, name }) => ({ id: fileId, name })),
        fileMessageIds: nextMessages,
        fileChannelId: problem.channelId,
    });
}
async function syncRemoteContent(guild, contest, problem, remote, auth) {
    const descriptionMoved = problem.descriptionChannelId != null && problem.descriptionChannelId !== problem.channelId;
    const filesMoved = problem.fileChannelId != null && problem.fileChannelId !== problem.channelId;
    const changes = (0, core_1.remoteContentChanges)({ description: problem.remoteDescription, files: problem.remoteFiles?.map((file) => ({ ...file, url: "" })) }, remote);
    if (remote.description !== undefined && (descriptionMoved || problem.remoteDescription !== remote.description))
        await replaceRemoteDescription(guild, problem, remote.description);
    if (remote.files !== undefined && (filesMoved || changes.some((change) => change.startsWith("파일 ")))) {
        await replaceRemoteFiles(guild, contest, (0, store_1.getProblem)(problem.id), remote, auth);
    }
    return changes;
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
async function syncRemoteChallenge(guild, contest, remote, auth) {
    const existing = (0, store_1.findProblemByExternalId)(guild.id, contest.key, remote.externalId) ?? (0, store_1.findProblem)(guild.id, contest.key, remote.name);
    if (!existing) {
        const created = await challenge(guild, contest, remote.category, remote.name, remote.externalId, false);
        if (!created)
            return { result: "unchanged", changes: [] };
        await syncRemoteContent(guild, contest, created, remote, auth);
        return { result: "created", changes: ["새 문제"], problem: (0, store_1.getProblem)(created.id) };
    }
    const patch = {};
    const changes = [];
    if (existing.name !== remote.name) {
        Object.assign(patch, { name: remote.name, nameKey: (0, store_1.keyOf)(remote.name) });
        changes.push("문제명");
    }
    if (existing.externalId !== remote.externalId)
        patch.externalId = remote.externalId;
    const remoteGenre = (0, core_1.normalizeCtfCategory)(remote.category);
    if (existing.genreKey !== remoteGenre && !existing.threadId) {
        if (existing.cardMessageId) {
            const oldChannel = await guild.channels.fetch(existing.channelId).catch(() => null);
            if (oldChannel?.type === discord_js_1.ChannelType.GuildText)
                await oldChannel.messages.delete(existing.cardMessageId).catch(() => undefined);
        }
        const nextChannel = await channel(guild, contest, `genre:${remoteGenre}`, `⬜｜${remoteGenre}`);
        Object.assign(patch, { genre: remoteGenre, genreKey: remoteGenre, channelId: nextChannel.id, cardMessageId: undefined });
        changes.push("문제 분야");
    }
    if (Object.keys(patch).length) {
        (0, store_1.patchProblem)(existing.id, patch);
        await refreshChallengeCard(guild, (0, store_1.getProblem)(existing.id));
    }
    changes.push(...await syncRemoteContent(guild, contest, (0, store_1.getProblem)(existing.id), remote, auth));
    const latest = (0, store_1.getProblem)(existing.id);
    return changes.length ? { result: "updated", changes, problem: latest } : { result: "unchanged", changes: [], problem: latest };
}
async function hydrateCtfdChallenges(contest, challenges, auth, selectedIds) {
    if (contest.platform !== "ctfd" || !contest.sourceUrl)
        return { challenges, failedIds: [] };
    return (0, platforms_1.fetchCtfdChallengeDetailsBatch)(contest.sourceUrl, challenges, selectedIds, auth);
}
client.once(discord_js_1.Events.ClientReady, async () => { for (const g of client.guilds.cache.values())
    if (!guildIds.length || guildIds.includes(g.id)) {
        await g.commands.set([command.toJSON()]);
        for (const c of (0, store_1.getContests)(g.id)) {
            const role = await g.roles.fetch(c.roleId).catch(() => null);
            const roleName = c.name.trim().slice(0, 100);
            if (role && role.name !== roleName)
                await role.setName(roleName).catch((error) => console.warn(`역할 이름 갱신 실패 (${c.name}):`, error));
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
        const updated = (0, store_1.patchContest)(i.guild.id, c.key, { startsAt: s, endsAt: e, teamName: i.options.getString("team") ?? c.teamName });
        await ensureContestAnnouncement(i.guild, updated);
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
        const modal = new discord_js_1.ModalBuilder().setCustomId(`ctf-pull:${pullId}`).setTitle("CTF 문제 가져오기").addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("url").setLabel("대회 주소").setPlaceholder("https://ctf.example.com").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("access-token").setLabel("API / Access Token (선택)").setStyle(discord_js_1.TextInputStyle.Paragraph).setRequired(false)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("session-cookie").setLabel("CTFd session 쿠키값 (선택)").setPlaceholder("session=... 또는 쿠키값만 입력").setStyle(discord_js_1.TextInputStyle.Paragraph).setRequired(false)));
        return void await i.showModal(modal);
    }
    if (sub === "warning" && c) {
        (0, store_1.patchContest)(i.guild.id, c.key, { warningEnabled: i.options.getBoolean("enabled", true) });
        return void await i.reply({ content: "변경 완료", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "defaultsettings")
        return void await i.reply({ content: "KST · Solve 1 · Contribute 0.5 · monitor 10s", flags: discord_js_1.MessageFlags.Ephemeral });
    if (["deletechallenge", "addpoint", "deletepoint"].includes(sub)) {
        const ps = (0, store_1.getProblems)(i.guild.id, c?.key);
        const menu = new discord_js_1.StringSelectMenuBuilder().setCustomId(`${sub}:${i.options.getUser("user")?.id ?? ""}:${i.options.getString("type") ?? ""}`).setPlaceholder("문제 선택").addOptions(ps.slice(0, 25).map(p => ({ label: p.name, value: p.id })));
        return void await i.reply({ content: "문제를 선택하세요.", components: [new discord_js_1.ActionRowBuilder().addComponents(menu)], flags: discord_js_1.MessageFlags.Ephemeral });
    }
}
async function pullModal(i) {
    const pullId = i.customId.slice(9), draft = pullDrafts.get(pullId);
    pullDrafts.delete(pullId);
    if (!i.guild || !draft || draft.guildId !== i.guild.id || draft.userId !== i.user.id || Date.now() - draft.createdAt > 300_000)
        return void await i.reply({ content: "Pull 입력 창이 만료되었습니다. `/ctf pull`을 다시 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
    const c = (0, store_1.getContest)(i.guild.id, draft.ctfKey);
    if (!c)
        return void await i.reply({ content: "CTF 공간을 찾을 수 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    await i.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    try {
        const url = i.fields.getTextInputValue("url").trim().replace(/\/+$/, "");
        const accessToken = i.fields.getTextInputValue("access-token").trim();
        const sessionCookie = i.fields.getTextInputValue("session-cookie").trim();
        if (accessToken && sessionCookie)
            return void await i.editReply("API 토큰과 CTFd session 쿠키 중 하나만 입력하세요.");
        const authenticationType = sessionCookie ? "session" : accessToken ? "token" : undefined;
        const authenticationSecret = sessionCookie || accessToken;
        const auth = authenticationSecret && authenticationType ? { type: authenticationType, value: authenticationSecret } : undefined;
        const encryptedAccessToken = authenticationSecret ? (0, secrets_1.encryptSecret)(authenticationSecret) : undefined;
        let platform, list;
        if (sessionCookie) {
            const result = await (0, platforms_1.fetchChallengesWithSession)(url, sessionCookie);
            platform = result.platform;
            list = result.challenges;
        }
        else {
            platform = await (0, platforms_1.detectPlatform)(url);
            if (platform === "hspace")
                list = await (0, platforms_1.fetchPublicChallenges)(platform, url, auth);
            else if (accessToken) {
                const result = await (0, platforms_1.fetchChallengesWithToken)(url, accessToken);
                platform = result.platform;
                list = result.challenges;
            }
            else {
                if (platform === "generic")
                    return void await i.editReply("지원되는 CTFd/rCTF/HSPACE 주소가 아니거나 인증정보가 필요합니다.");
                list = await (0, platforms_1.fetchPublicChallenges)(platform, url);
            }
        }
        const schedule = platform === "ctfd" ? await (0, platforms_1.fetchCtfdContestSchedule)(url, auth).catch(() => undefined) : undefined;
        const scheduleChanged = !!schedule && (schedule.startsAt !== c.startsAt || schedule.endsAt !== c.endsAt);
        const startsAt = schedule?.startsAt ?? c.startsAt;
        const endsAt = schedule?.endsAt ?? c.endsAt;
        const ongoing = endsAt > Date.now();
        const updatedContest = (0, store_1.patchContest)(i.guild.id, c.key, { startsAt, endsAt, platform, sourceUrl: url, publicApiReadable: ongoing, encryptedAccessToken: ongoing ? encryptedAccessToken : undefined, authenticationType: ongoing ? authenticationType : undefined, monitorError: undefined, monitorErrorAt: undefined });
        if (scheduleChanged)
            await ensureContestAnnouncement(i.guild, updatedContest);
        let detailFailures = 0;
        if (platform === "ctfd") {
            const hydrated = await hydrateCtfdChallenges(updatedContest, list, auth, new Set(list.map((remote) => remote.externalId)));
            list = hydrated.challenges;
            detailFailures = hydrated.failedIds.length;
        }
        let added = 0, updated = 0;
        for (const remote of list) {
            const outcome = await syncRemoteChallenge(i.guild, updatedContest, remote, auth);
            if (outcome.result === "created")
                added++;
            else if (outcome.result === "updated")
                updated++;
        }
        if (added || updated)
            await status(i.guild, updatedContest);
        const scheduleMessage = schedule ? `\nCTFd 일정 자동 반영: <t:${Math.floor(startsAt / 1000)}:f> ~ <t:${Math.floor(endsAt / 1000)}:f>` : platform === "ctfd" ? "\nCTFd에서 일정을 찾지 못해 기존 일정을 유지했습니다." : "";
        const authMessage = authenticationSecret ? (ongoing ? `\n${authenticationType === "session" ? "세션 쿠키" : "토큰"}을 암호화해 이 대회의 자동 감시에 저장했습니다.` : `\n종료된 대회라 ${authenticationType === "session" ? "세션 쿠키" : "토큰"}은 저장하지 않았습니다.`) : "";
        const detailMessage = detailFailures ? `\n상세 조회 실패: ${detailFailures}개(기본 문제 정보는 반영됨)` : "";
        return void await i.editReply(`${list.length}개 확인 · ${added}개 추가 · ${updated}개 갱신${scheduleMessage}${authMessage}${detailMessage}`);
    }
    catch (error) {
        return void await i.editReply(`Pull 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
}
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
async function select(custom, pid, i) {
    const [kind, user, amount] = custom.split(":");
    const p = (0, store_1.getProblem)(pid);
    if (!p)
        return;
    if (kind === "deletechallenge") {
        if (p.threadId)
            await i.guild.channels.delete(p.threadId).catch(() => undefined);
        if (p.cardMessageId) {
            const ch = await i.guild.channels.fetch(p.channelId).catch(() => null);
            if (ch?.type === discord_js_1.ChannelType.GuildText)
                await ch.messages.delete(p.cardMessageId).catch(() => undefined);
        }
        await deleteRemoteMessages(i.guild, p.descriptionChannelId ?? p.channelId, p.descriptionMessageIds ?? []);
        await deleteRemoteMessages(i.guild, p.fileChannelId ?? p.channelId, Object.values(p.fileMessageIds ?? {}));
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
    }
    await status(i.guild, (0, store_1.getContest)(i.guild.id, p.ctfKey));
    await i.update({ content: "완료", components: [] });
}
let monitorRunning = false;
async function notifyMonitorError(guild, contest, error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    if (contest.monitorError === message && Date.now() - (contest.monitorErrorAt ?? 0) < 60 * 60_000)
        return;
    const credentialChannel = await channel(guild, contest, "credential", "🔑｜credential");
    await credentialChannel.send(`⚠️ **${contest.name}** 문제 자동 감시에 실패했습니다.\n${message}\n인증이 만료됐다면 \`/ctf pull\`로 다시 입력하세요.`);
    (0, store_1.patchContest)(guild.id, contest.key, { monitorError: message, monitorErrorAt: Date.now() });
}
function queueRemoteAnnouncement(guildId, contest, message) {
    (0, store_1.patchContest)(guildId, contest.key, { pendingRemoteAnnouncements: (0, core_1.appendRemoteAnnouncement)(contest.pendingRemoteAnnouncements, message) });
}
async function flushRemoteAnnouncements(guild, contest) {
    let pending = (0, store_1.getContest)(guild.id, contest.key)?.pendingRemoteAnnouncements ?? [];
    if (!pending.length)
        return;
    const general = await channel(guild, contest, "general", "general");
    while (pending.length) {
        await general.send({ content: pending[0], allowedMentions: { parse: [] } });
        pending = pending.slice(1);
        (0, store_1.patchContest)(guild.id, contest.key, { pendingRemoteAnnouncements: pending });
    }
}
async function monitorContests() {
    if (monitorRunning)
        return;
    monitorRunning = true;
    try {
        const now = Date.now();
        for (const guild of client.guilds.cache.values())
            for (const contest of (0, store_1.getContests)(guild.id)) {
                if (contest.endsAt <= now) {
                    if (contest.warningEnabled || contest.publicApiReadable || contest.encryptedAccessToken || contest.monitorError)
                        (0, store_1.patchContest)(guild.id, contest.key, { warningEnabled: false, publicApiReadable: false, encryptedAccessToken: undefined, authenticationType: undefined, monitorError: undefined, monitorErrorAt: undefined });
                    continue;
                }
                if (!contest.warningEnabled || !contest.publicApiReadable || !contest.platform || !contest.sourceUrl)
                    continue;
                try {
                    const accessToken = contest.encryptedAccessToken ? (0, secrets_1.decryptSecret)(contest.encryptedAccessToken) : undefined;
                    const auth = accessToken ? { type: contest.authenticationType ?? "token", value: accessToken } : undefined;
                    let remotes = await (0, platforms_1.fetchPublicChallenges)(contest.platform, contest.sourceUrl, auth);
                    let detailFailures = 0;
                    if (contest.platform === "ctfd") {
                        const cursorKey = `${guild.id}:${contest.key}`;
                        const batch = (0, core_1.selectChallengeDetailBatch)(remotes.map((remote) => remote.externalId), challengeDetailCursors.get(cursorKey) ?? 0, 5);
                        challengeDetailCursors.set(cursorKey, batch.nextCursor);
                        const selected = new Set(batch.ids);
                        for (const remote of remotes)
                            if (!(0, store_1.findProblemByExternalId)(guild.id, contest.key, remote.externalId))
                                selected.add(remote.externalId);
                        const hydrated = await hydrateCtfdChallenges(contest, remotes, auth, selected);
                        remotes = hydrated.challenges;
                        detailFailures = hydrated.failedIds.length;
                        if (detailFailures)
                            await notifyMonitorError(guild, contest, new Error(`CTFd 문제 상세 ${detailFailures}개 조회 실패`));
                    }
                    let changed = 0;
                    for (const remote of remotes) {
                        const outcome = await syncRemoteChallenge(guild, contest, remote, auth);
                        if (outcome.result === "unchanged" || !outcome.problem)
                            continue;
                        changed++;
                        queueRemoteAnnouncement(guild.id, contest, (0, core_1.remoteSyncAnnouncement)(outcome.problem.name, outcome.problem.channelId, outcome.result, outcome.changes));
                    }
                    if (changed)
                        await status(guild, contest);
                    await flushRemoteAnnouncements(guild, contest);
                    if (contest.monitorError && detailFailures === 0)
                        (0, store_1.patchContest)(guild.id, contest.key, { monitorError: undefined, monitorErrorAt: undefined });
                }
                catch (error) {
                    await notifyMonitorError(guild, contest, error).catch((notifyError) => console.error("감시 오류 알림 실패:", notifyError));
                }
            }
    }
    finally {
        monitorRunning = false;
    }
}
const monitorIntervalSeconds = Math.max(10, Number(process.env.CTF_MONITOR_INTERVAL_SECONDS) || 10);
setInterval(() => void monitorContests().catch((error) => console.error("자동 감시 실패:", error)), monitorIntervalSeconds * 1000).unref();
client.login(token);
