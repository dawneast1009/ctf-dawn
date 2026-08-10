"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_crypto_1 = require("node:crypto");
const node_http_1 = require("node:http");
const discord_js_1 = require("discord.js");
const store_1 = require("./store");
const core_1 = require("./ctf/core");
const platforms_1 = require("./ctf/platforms");
const core_2 = require("./events/core");
const sources_1 = require("./events/sources");
const translation_1 = require("./events/translation");
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    console.error("환경변수 DISCORD_TOKEN 이 설정되지 않았습니다. .env 또는 패널 환경변수를 확인하세요.");
    process.exit(1);
}
const GUILD_IDS = (process.env.GUILD_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
/** 민감한 봇 설정과 Discord 역할 구조를 변경할 수 있는 유일한 사용자. */
const BOT_OWNER_ID = process.env.BOT_OWNER_ID?.trim() || undefined;
const genId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function envBool(name, defaultValue = false) {
    const value = process.env[name];
    if (value == null || value === "")
        return defaultValue;
    return /^(1|true|yes|on)$/i.test(value);
}
/** "24h", "2d", "1d12h", "90m" → 밀리초. 인식 못하면 null */
function parseDuration(input) {
    const str = input.trim().toLowerCase();
    if (!str)
        return null;
    let ms = 0;
    let matched = false;
    const re = /(\d+)\s*([dhm])/g;
    let m;
    while ((m = re.exec(str))) {
        matched = true;
        const n = Number(m[1]);
        if (m[2] === "d")
            ms += n * 86400000;
        else if (m[2] === "h")
            ms += n * 3600000;
        else
            ms += n * 60000;
    }
    return matched ? ms : null;
}
function parseTier(input) {
    const trimmed = input.trim();
    const m = trimmed.match(/^(.+?)\s*(\d+)\s*$/);
    if (m) {
        const base = m[1].trim();
        const level = Number(m[2]);
        return { label: `${base}${level}`, base, level };
    }
    return { label: trimmed, base: trimmed, level: null };
}
const drafts = new Map();
const ctfDrafts = new Map();
/** /ctf solve 진행 상태: userId -> { problemId, solver?, helpers? } */
const ctfSolveDrafts = new Map();
const pendingEventImports = new Map();
const intents = [discord_js_1.GatewayIntentBits.Guilds];
if (process.env.ENABLE_LOGGING_INTENTS === "true") {
    intents.push(discord_js_1.GatewayIntentBits.GuildMembers, discord_js_1.GatewayIntentBits.GuildInvites);
}
const client = new discord_js_1.Client({ intents });
// ── 슬래시 명령어 정의 (기능별) ───────────────────────────────────────
const ctfFeatureCommands = [
    new discord_js_1.SlashCommandBuilder()
        .setName("문제")
        .setDescription("드림핵식 CTF 문제 관리")
        .addSubcommand((s) => s.setName("생성").setDescription("새 문제를 생성합니다 (드림핵/CTF 선택)"))
        .addSubcommand((s) => s.setName("삭제").setDescription("드림핵 문제를 삭제합니다 (출제자/관리자)"))
        .addSubcommand((s) => s.setName("스코어보드").setDescription("드림핵 정답자 랭킹"))
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("ctf")
        .setDescription("CTF workspace and contribution management")
        .addSubcommand((s) => s.setName("create").setDescription("Create a CTF workspace")
        .addStringOption((o) => o.setName("name").setDescription("CTF name").setRequired(true))
        .addStringOption((o) => o.setName("start").setDescription("KST: YYYY-MM-DD HH:mm").setRequired(true))
        .addStringOption((o) => o.setName("end").setDescription("KST: YYYY-MM-DD HH:mm").setRequired(true))
        .addStringOption((o) => o.setName("team").setDescription("External scoreboard team name (optional)").setRequired(false)))
        .addSubcommand((s) => s.setName("createchallenge").setDescription("Create a challenge in this CTF")
        .addStringOption((o) => o.setName("category").setDescription("Challenge category, saved lowercase").setRequired(true))
        .addStringOption((o) => o.setName("name").setDescription("Challenge name").setRequired(true)))
        .addSubcommand((s) => s.setName("solve").setDescription("Record solver and contributors in this challenge thread"))
        .addSubcommand((s) => s.setName("edit").setDescription("Edit current CTF information")
        .addStringOption((o) => o.setName("start").setDescription("New KST start: YYYY-MM-DD HH:mm").setRequired(false))
        .addStringOption((o) => o.setName("end").setDescription("New KST end: YYYY-MM-DD HH:mm").setRequired(false))
        .addStringOption((o) => o.setName("team").setDescription("External scoreboard team name").setRequired(false)))
        .addSubcommand((s) => s.setName("deletechallenge").setDescription("Delete a challenge"))
        .addSubcommand((s) => s.setName("addpoint").setDescription("Add Solve or Contribute record")
        .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption((o) => o.setName("type").setDescription("Contribution type").setRequired(true)
        .addChoices({ name: "Solve (1)", value: "1" }, { name: "Contribute (0.5)", value: "0.5" })))
        .addSubcommand((s) => s.setName("deletepoint").setDescription("Delete a contribution record")
        .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)))
        .addSubcommand((s) => s.setName("history").setDescription("Show your CTF activity history"))
        .addSubcommand((s) => s.setName("info").setDescription("Show current CTF information"))
        .addSubcommand((s) => s.setName("profile").setDescription("Show a member's cumulative CTF profile")
        .addUserOption((o) => o.setName("user").setDescription("Member (default: you)").setRequired(false)))
        .addSubcommand((s) => s.setName("defaultsettings").setDescription("Show default workspace settings"))
        .addSubcommand((s) => s.setName("warning").setDescription("Toggle low-impact new challenge monitoring")
        .addBooleanOption((o) => o.setName("enabled").setDescription("Monitoring state").setRequired(true)))
        .addSubcommand((s) => s.setName("pull").setDescription("Read challenges from a CTF platform"))
        .addSubcommand((s) => s
        .setName("leaderboard")
        .setDescription("Show cumulative contribution leaderboard")
        .addStringOption((o) => o.setName("ctf").setDescription("특정 CTF 이름만 보기").setRequired(false)))
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("ctf관리")
        .setDescription("봇 소유자 전용 CTF 역할·대회 관리")
        .setDefaultMemberPermissions(0n)
        .addSubcommand((s) => s.setName("추가").setDescription("CTF 문제를 수동으로 추가"))
        .addSubcommand((s) => s.setName("대회삭제").setDescription("CTF 대회와 참가 역할을 통째로 삭제"))
        .addSubcommand((s) => s
        .setName("점수추가")
        .setDescription("수동으로 솔브 추가")
        .addUserOption((o) => o.setName("user").setDescription("대상 유저").setRequired(true))
        .addStringOption((o) => o
        .setName("기여")
        .setDescription("기여도 (기본: 푼 사람)")
        .setRequired(false)
        .addChoices({ name: "푼 사람 (1솔브)", value: "1" }, { name: "도와준 사람 (0.5솔브)", value: "0.5" })))
        .addSubcommand((s) => s.setName("pull").setDescription("CTFd 사이트에 로그인해 문제 가져오기"))
        .addSubcommand((s) => s.setName("import").setDescription("문제 목록을 붙여넣어 한 번에 등록"))
        .addSubcommand((s) => s
        .setName("시간")
        .setDescription("대회 기간 설정")
        .addStringOption((o) => o.setName("ctf").setDescription("CTF 이름").setRequired(true))
        .addStringOption((o) => o.setName("기간").setDescription("지금부터 진행 시간. 예: 24h, 2d, 1d12h").setRequired(true)))
        .toJSON(),
];
const loggingFeatureCommands = [
    new discord_js_1.SlashCommandBuilder()
        .setName("로그채널")
        .setDescription("입장/퇴장 로그를 보낼 채널을 설정합니다")
        .addChannelOption((o) => o.setName("채널").setDescription("로그를 보낼 채널").setRequired(true))
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("로그채널확인")
        .setDescription("현재 설정된 로그 채널을 확인합니다")
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .toJSON(),
];
const eventFeatureCommands = [
    new discord_js_1.SlashCommandBuilder()
        .setName("event_sync")
        .setDescription("보안뉴스/CTF/해커톤/컨퍼런스 소식을 즉시 수집해 게시합니다")
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_status")
        .setDescription("보안뉴스/행사 수집 상태를 확인합니다")
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_upcoming")
        .setDescription("최근 수집한 보안뉴스/행사 목록을 봅니다")
        .addIntegerOption((o) => o.setName("count").setDescription("표시할 개수 (기본 10)").setRequired(false).setMinValue(1).setMaxValue(20))
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_add")
        .setDescription("보안뉴스/행사를 수동으로 추가합니다")
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .addStringOption((o) => o.setName("title").setDescription("제목").setRequired(true))
        .addStringOption((o) => o
        .setName("kind")
        .setDescription("분류")
        .setRequired(false)
        .addChoices({ name: "CTF 대회", value: "ctf" }, { name: "AI 경진대회", value: "ai" }, { name: "보안 컨퍼런스", value: "conference" }, { name: "보안 해커톤", value: "hackathon" }, { name: "기타 정보보안", value: "security" }, { name: "정보보안 소식", value: "news" }))
        .addStringOption((o) => o.setName("url").setDescription("공식 링크").setRequired(false))
        .addStringOption((o) => o.setName("registration_deadline").setDescription("접수 마감일 (YYYY-MM-DD)").setRequired(false))
        .addStringOption((o) => o.setName("start").setDescription("시작일 (YYYY-MM-DD)").setRequired(false))
        .addStringOption((o) => o.setName("end").setDescription("종료일 (YYYY-MM-DD)").setRequired(false))
        .addStringOption((o) => o.setName("organizer").setDescription("주최 기관").setRequired(false))
        .addStringOption((o) => o.setName("eligibility").setDescription("참가 대상").setRequired(false))
        .addStringOption((o) => o.setName("registration").setDescription("모집/접수 일정 원문").setRequired(false))
        .addStringOption((o) => o.setName("team_limit").setDescription("팀 또는 인원 제한").setRequired(false))
        .addStringOption((o) => o
        .setName("participation_mode")
        .setDescription("진행 방식")
        .setRequired(false)
        .addChoices({ name: "정보 없음", value: "정보 없음" }, { name: "온라인", value: "온라인" }, { name: "오프라인", value: "오프라인" }, { name: "온·오프라인 병행", value: "온·오프라인 병행" }))
        .addStringOption((o) => o.setName("location").setDescription("장소").setRequired(false))
        .addStringOption((o) => o.setName("description").setDescription("설명").setRequired(false))
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_remove")
        .setDescription("수집/등록된 보안뉴스·행사를 삭제합니다")
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_import")
        .setDescription("보안뉴스/행사 목록을 붙여넣어 한 번에 등록합니다")
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_import_url")
        .setDescription("사이트 상세 페이지 링크를 읽어 행사로 등록합니다")
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .addStringOption((o) => o.setName("url").setDescription("분석할 상세 페이지 URL").setRequired(true))
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_reset")
        .setDescription("보안뉴스/행사 수집 기록을 초기화합니다")
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
        .addBooleanOption((o) => o.setName("confirm").setDescription("true면 즉시 삭제합니다").setRequired(false))
        .toJSON(),
    new discord_js_1.SlashCommandBuilder()
        .setName("event_list_manual")
        .setDescription("수동 등록 행사 목록을 조회합니다")
        .toJSON(),
];
// 항상 등록되는 기능 관리 명령어
const botCommand = new discord_js_1.SlashCommandBuilder()
    .setName("봇")
    .setDescription("봇 기능 켜기/끄기")
    // Discord 관리자는 명령 권한 제한을 우회할 수 있으므로 실제 소유자 검사는
    // interaction 처리 시 한 번 더 수행한다.
    .setDefaultMemberPermissions(0n)
    .addSubcommandGroup((g) => g
    .setName("기능")
    .setDescription("기능 관리")
    .addSubcommand((s) => s.setName("추가").setDescription("기능을 켭니다 (해당 명령어가 보이게 됩니다)"))
    .addSubcommand((s) => s.setName("삭제").setDescription("기능을 끕니다"))
    .addSubcommand((s) => s.setName("목록").setDescription("켜진 기능을 봅니다")))
    .toJSON();
// 기능 레지스트리
const FEATURES = {
    ctf: { label: "CTF · 드림핵 문제 관리", desc: "/문제, /ctf, /ctf관리 명령어", commands: ctfFeatureCommands },
    events: { label: "보안뉴스 · 행사 공지", desc: "/event_sync, /event_add, /event_import 등", commands: eventFeatureCommands },
    logging: { label: "입장/퇴장 로그", desc: "/로그채널 + 초대 추적·입퇴장 알림", commands: loggingFeatureCommands },
};
/** 각 명령어가 속한 기능 키 */
const COMMAND_FEATURE = {
    문제: "ctf",
    ctf: "ctf",
    ctf관리: "ctf",
    event_sync: "events",
    event_status: "events",
    event_upcoming: "events",
    event_add: "events",
    event_remove: "events",
    event_import: "events",
    event_import_url: "events",
    event_reset: "events",
    event_list_manual: "events",
    로그채널: "logging",
    로그채널확인: "logging",
};
function commandsForGuild(guildId) {
    const out = [botCommand];
    for (const key of (0, store_1.getFeatures)(guildId)) {
        if (FEATURES[key])
            out.push(...FEATURES[key].commands);
    }
    return out;
}
async function registerGuild(guild) {
    if (GUILD_IDS.length && !GUILD_IDS.includes(guild.id))
        return;
    await guild.commands.set(commandsForGuild(guild.id)).catch((e) => console.error(`명령어 등록 실패(${guild.id}):`, e?.message ?? e));
}
const inviteCache = new Map();
const eventSyncTimers = new Map();
const eventSyncJobs = new Map();
let sharedCollection;
let sharedCollectionJob;
const ctfMonitorTimers = new Map();
const ctfMonitorBusy = new Set();
const ctfMonitorBackoff = new Map();
const ctfScoreboardSnapshots = new Map();
const ctfTeamSnapshots = new Map();
async function monitorCtfContest(guild, contest) {
    if (!contest.warningEnabled || !contest.publicApiReadable || !contest.sourceUrl || !contest.platform || contest.platform === "generic")
        return;
    const monitorKey = `${guild.id}:${contest.key}`;
    const backoff = ctfMonitorBackoff.get(monitorKey);
    if (backoff && Date.now() < backoff.nextAt)
        return;
    try {
        const remote = await (0, platforms_1.fetchPublicChallenges)(contest.platform, contest.sourceUrl);
        const known = (0, store_1.getGuildCtfProblems)(guild.id).filter((problem) => problem.ctfKey === contest.key);
        const knownExternal = new Set(known.map((problem) => problem.externalId).filter(Boolean));
        const { categoryId, roleId } = await getOrCreateCtf(guild, contest.name);
        let added = 0;
        for (const challenge of remote.slice(0, 100)) {
            if (knownExternal.has(challenge.externalId) || (0, store_1.findCtfProblem)(guild.id, contest.key, (0, store_1.keyOf)(challenge.name)))
                continue;
            const category = (0, core_1.normalizeCtfCategory)(challenge.category);
            const channel = await ensureGenreForum(guild, contest.key, categoryId, roleId, category);
            await createCtfPost(guild, channel, contest.name, contest.key, challenge.name, category, client.user.id, challenge.externalId);
            added++;
        }
        if (added) {
            const announce = await ctfCoreChannel(guild, contest.key, "announce");
            await announce?.send(`📣 새 문제 **${added}개**를 확인했습니다. All Solve 상태를 다시 계산했습니다.`).catch(() => { });
        }
        const scoreboard = await (0, platforms_1.fetchPublicScoreboard)(contest.platform, contest.sourceUrl).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "RATE_LIMITED" || /^HTTP_5\d\d$/.test(message))
                throw error;
            return [];
        });
        if (scoreboard.length) {
            const signature = JSON.stringify(scoreboard.map((row) => [row.name, row.score, row.rank]));
            const previous = ctfScoreboardSnapshots.get(monitorKey);
            ctfScoreboardSnapshots.set(monitorKey, signature);
            if (previous && previous !== signature) {
                const feed = await ctfCoreChannel(guild, contest.key, "feed");
                const body = scoreboard.slice(0, 10).map((row) => `${row.rank}. **${row.name}** · ${row.score}pts`).join("\n");
                await feed?.send({ embeds: [new discord_js_1.EmbedBuilder().setTitle("📊 TOP 10 scoreboard changed").setColor(0x5865f2).setDescription(body)] }).catch(() => { });
            }
            if (contest.teamName) {
                const ours = scoreboard.find((row) => (0, store_1.keyOf)(row.name) === (0, store_1.keyOf)(contest.teamName));
                const old = ctfTeamSnapshots.get(monitorKey);
                if (ours) {
                    ctfTeamSnapshots.set(monitorKey, { score: ours.score, rank: ours.rank });
                    if (old && (old.score !== ours.score || old.rank !== ours.rank)) {
                        const feed = await ctfCoreChannel(guild, contest.key, "feed");
                        await feed?.send(`🌟🔥 우리 팀 **${contest.teamName}** 변경: ${old.score}pts → ${ours.score}pts | ${old.rank}위 → ${ours.rank}위`).catch(() => { });
                    }
                }
            }
        }
        ctfMonitorBackoff.delete(monitorKey);
    }
    catch (error) {
        const previousDelay = ctfMonitorBackoff.get(monitorKey)?.delay ?? 60_000;
        const delay = Math.min(previousDelay * 2, 15 * 60_000);
        ctfMonitorBackoff.set(monitorKey, { nextAt: Date.now() + delay, delay });
        console.warn(`CTF 저부하 감시 실패(${contest.name}, ${Math.round(delay / 1000)}초 후 재시도):`, error instanceof Error ? error.message : error);
    }
}
function ensureCtfMonitor(guild) {
    if (ctfMonitorTimers.has(guild.id))
        return;
    const interval = Math.max(60, Number(process.env.CTF_MONITOR_INTERVAL_SECONDS ?? 120) || 120) * 1000;
    const run = async () => {
        if (ctfMonitorBusy.has(guild.id))
            return;
        ctfMonitorBusy.add(guild.id);
        try {
            for (const contest of (0, store_1.getGuildCtfContests)(guild.id))
                await monitorCtfContest(guild, contest);
        }
        finally {
            ctfMonitorBusy.delete(guild.id);
        }
    };
    const timer = setInterval(() => void run(), interval);
    timer.unref();
    ctfMonitorTimers.set(guild.id, timer);
}
async function collectEventsShared(options) {
    if (sharedCollection && Date.now() - sharedCollection.createdAt < 5 * 60_000)
        return sharedCollection.result;
    if (sharedCollectionJob)
        return sharedCollectionJob;
    sharedCollectionJob = (0, sources_1.collectEventItems)(options);
    try {
        const result = await sharedCollectionJob;
        sharedCollection = { createdAt: Date.now(), result };
        return result;
    }
    finally {
        sharedCollectionJob = undefined;
    }
}
function releaseUnusedMemory() {
    const gc = globalThis.gc;
    if (gc)
        setTimeout(() => gc(), 500).unref();
}
async function cacheInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        const map = new Map();
        invites.forEach((inv) => map.set(inv.code, {
            uses: inv.uses ?? 0,
            inviterTag: inv.inviter?.tag ?? "알 수 없음",
            inviterMention: inv.inviter ? `<@${inv.inviter.id}>` : "알 수 없음",
        }));
        inviteCache.set(guild.id, map);
    }
    catch {
        /* 권한 없으면 무시 */
    }
}
function ensureEventScheduler(guild) {
    if (!envBool("ENABLE_AUTO_DISCOVERY", true))
        return;
    if (eventSyncTimers.has(guild.id))
        return;
    const minutes = Math.max(10, Number(process.env.EVENT_SYNC_INTERVAL_MINUTES ?? process.env.SYNC_INTERVAL_MINUTES ?? 180) || 180);
    const timer = setInterval(() => {
        if (!(0, store_1.getFeatures)(guild.id).includes("events"))
            return;
        syncEvents(guild).catch((e) => {
            (0, store_1.setEventStatus)(guild.id, {
                lastSyncAt: Date.now(),
                lastOk: false,
                lastMessage: e?.message ?? "자동 수집 실패",
                fetched: 0,
                posted: 0,
            });
        });
    }, minutes * 60000);
    eventSyncTimers.set(guild.id, timer);
    setTimeout(() => {
        if (!(0, store_1.getFeatures)(guild.id).includes("events"))
            return;
        syncEvents(guild).catch((error) => {
            (0, store_1.setEventStatus)(guild.id, {
                lastSyncAt: Date.now(),
                lastOk: false,
                lastMessage: error instanceof Error ? error.message : "초기 자동 수집 실패",
                fetched: 0,
                posted: 0,
                updated: 0,
                unchanged: 0,
            });
        });
    }, 2_000);
}
client.once(discord_js_1.Events.ClientReady, async (c) => {
    console.log(`로그인 완료: ${c.user.tag}`);
    for (const guild of c.guilds.cache.values()) {
        if (GUILD_IDS.length && !GUILD_IDS.includes(guild.id))
            continue;
        await registerGuild(guild);
        if ((0, store_1.getFeatures)(guild.id).includes("logging"))
            await cacheInvites(guild);
        if ((0, store_1.getFeatures)(guild.id).includes("events")) {
            await ensureEventForums(guild);
            ensureEventScheduler(guild);
        }
        if ((0, store_1.getFeatures)(guild.id).includes("ctf"))
            ensureCtfMonitor(guild);
    }
    console.log(`명령어 등록 완료: ${c.guilds.cache.size}개 서버`);
});
client.on(discord_js_1.Events.GuildCreate, async (guild) => {
    if (GUILD_IDS.length && !GUILD_IDS.includes(guild.id))
        return;
    await registerGuild(guild);
    if ((0, store_1.getFeatures)(guild.id).includes("events")) {
        await ensureEventForums(guild);
        ensureEventScheduler(guild);
    }
    if ((0, store_1.getFeatures)(guild.id).includes("ctf"))
        ensureCtfMonitor(guild);
});
// ── 패널 렌더링 ───────────────────────────────────────────────────────
function buildSourceSelect(includeCtfManagement) {
    const options = [
        { label: "Dreamhack (플래그형)", value: "dh", emoji: "🐲", description: "플래그를 맞히면 풀이방 입장" },
    ];
    if (includeCtfManagement) {
        options.push({ label: "CTF / 워게임", value: "ctf", emoji: "🚩", description: "CTF 이름을 적고 토론 + /ctf solve 로 기록" });
    }
    const menu = new discord_js_1.StringSelectMenuBuilder().setCustomId("src_select").setPlaceholder("문제 출처를 고르세요").addOptions(options);
    return {
        content: "어디 문제인가요? 출처를 골라주세요.",
        components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
        flags: discord_js_1.MessageFlags.Ephemeral,
    };
}
function buildPanel(state) {
    const ready = Boolean(state.name && state.flag && state.tier && state.genre);
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle("🐲 드림핵식 문제 생성")
        .setColor(ready ? 0x57f287 : 0x5865f2)
        .setDescription("아래 버튼을 눌러 항목을 채운 뒤 **제출**하세요.")
        .addFields({ name: "📝 문제 이름", value: state.name ?? "`(미설정)`" }, { name: "🏴 정답(플래그)", value: state.flag ? "`✅ 설정됨`" : "`(미설정)`" }, { name: "📂 장르(카테고리)", value: state.genre ? `\`${state.genre}\`` : "`(미설정)`  예: web, pwn, crypto" }, { name: "🏅 티어", value: state.tier ? `\`${state.tier}\`  (예: 브론즈1 → 태그 브론즈)` : "`(미설정)`" });
    const row1 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId("c_name").setLabel("문제 이름").setEmoji("📝").setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId("c_flag").setLabel("문제의 답").setEmoji("🏴").setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId("c_genre").setLabel("장르").setEmoji("📂").setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId("c_tier").setLabel("티어").setEmoji("🏅").setStyle(discord_js_1.ButtonStyle.Primary));
    const row2 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId("c_submit").setLabel("제출").setEmoji("✅").setStyle(discord_js_1.ButtonStyle.Success).setDisabled(!ready), new discord_js_1.ButtonBuilder().setCustomId("c_cancel").setLabel("취소").setStyle(discord_js_1.ButtonStyle.Danger));
    return { content: "", embeds: [embed], components: [row1, row2] };
}
function buildCtfPanel(state) {
    const ready = Boolean(state.ctfName && state.genre && state.name);
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle("🚩 CTF 문제 추가")
        .setColor(ready ? 0x57f287 : 0xeb459e)
        .setDescription("CTF/워게임 이름, 장르, 문제 이름을 채운 뒤 **제출**하세요.")
        .addFields({ name: "🏟️ CTF 이름", value: state.ctfName ? `\`${state.ctfName}\`` : "`(미설정)`  예: Codegate, 드림핵 워게임" }, { name: "📂 장르(카테고리)", value: state.genre ? `\`${state.genre}\`` : "`(미설정)`  예: web, pwn, crypto" }, { name: "📝 문제 이름", value: state.name ?? "`(미설정)`" });
    const row1 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId("cf_ctf").setLabel("CTF 이름").setEmoji("🏟️").setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId("cf_genre").setLabel("장르").setEmoji("📂").setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId("cf_name").setLabel("문제 이름").setEmoji("📝").setStyle(discord_js_1.ButtonStyle.Primary));
    const row2 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId("cf_submit").setLabel("제출").setEmoji("✅").setStyle(discord_js_1.ButtonStyle.Success).setDisabled(!ready), new discord_js_1.ButtonBuilder().setCustomId("cf_cancel").setLabel("취소").setStyle(discord_js_1.ButtonStyle.Danger));
    return { content: "", embeds: [embed], components: [row1, row2] };
}
// ── 채널/태그 확보 ────────────────────────────────────────────────────
async function ensureForum(guild, sourceKey, name) {
    const existingId = (0, store_1.getForumFor)(guild.id, sourceKey);
    if (existingId) {
        const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
        if (ch && ch.type === discord_js_1.ChannelType.GuildForum)
            return ch;
    }
    const ch = await guild.channels.create({
        name: name.slice(0, 95),
        type: discord_js_1.ChannelType.GuildForum,
        topic: "CTF 문제 모음 — 게시글에서 버튼/명령으로 참여하고 기록합니다.",
    });
    (0, store_1.setForumFor)(guild.id, sourceKey, ch.id);
    return ch;
}
async function ensureVault(guild) {
    const existingId = (0, store_1.getVault)(guild.id);
    if (existingId) {
        const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
        if (ch && ch.type === discord_js_1.ChannelType.GuildText)
            return ch;
    }
    const ch = await guild.channels.create({
        name: "🔒-풀이방-보관소",
        type: discord_js_1.ChannelType.GuildText,
        topic: "정답자 전용 비공개 풀이방이 모이는 곳입니다.",
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] }],
    });
    (0, store_1.setVault)(guild.id, ch.id);
    return ch;
}
async function ensurePublicText(guild, key, name, topic) {
    const existingId = (0, store_1.getForumFor)(guild.id, key);
    if (existingId) {
        const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
        if (ch && ch.type === discord_js_1.ChannelType.GuildText)
            return ch;
    }
    const ch = await guild.channels.create({
        name,
        type: discord_js_1.ChannelType.GuildText,
        topic,
        permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [discord_js_1.PermissionFlagsBits.SendMessages] },
            { id: guild.members.me.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.EmbedLinks] },
        ],
    });
    (0, store_1.setForumFor)(guild.id, key, ch.id);
    return ch;
}
const ensureLobby = (guild) => ensurePublicText(guild, "_ctflobby", "🚩-ctf-로비", "CTF 참가 버튼을 누르면 그 대회 문제가 보입니다.");
const ensureSolveChannel = (guild) => ensurePublicText(guild, "_solvelog", "🏅-solve-기록", "푼 문제 기록이 올라옵니다.");
const CTF_CORE_CHANNELS = [
    ["general", "general", "CTF team discussion"],
    ["bot-command", "bot-command", "CTF bot commands"],
    ["announce", "📣｜announce", "Competition announcements"],
    ["credential", "🔑｜credential", "Shared credentials. Only CTF participants can view this channel."],
    ["solve", "📃｜solve", "Internal solve and contribution records"],
    ["feed", "🤝｜feed", "Participation and scoreboard changes"],
];
async function ensureCtfTextChannel(guild, ctfKey, categoryId, key, name, topic) {
    const storeKey = `ctftext:${ctfKey}:${key}`;
    const existingId = (0, store_1.getForumFor)(guild.id, storeKey);
    if (existingId) {
        const existing = guild.channels.cache.get(existingId) ?? await guild.channels.fetch(existingId).catch(() => null);
        if (existing?.type === discord_js_1.ChannelType.GuildText)
            return existing;
    }
    const channel = await guild.channels.create({ name, type: discord_js_1.ChannelType.GuildText, parent: categoryId, topic });
    (0, store_1.setForumFor)(guild.id, storeKey, channel.id);
    return channel;
}
/** CTF 참가자 역할 + 비공개 카테고리 + 기본 텍스트 채널 확보 */
async function getOrCreateCtf(guild, ctfName, options = {}) {
    const ctfKey = (0, store_1.keyOf)(ctfName);
    // 역할 (이 역할이 있어야 CTF 카테고리/채널이 보임)
    let roleId = (0, store_1.getCtfRole)(guild.id, ctfKey);
    let role = roleId ? guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null)) : null;
    if (!role) {
        role = await guild.roles.create({ name: `CTF: ${ctfName}`.slice(0, 90), mentionable: false });
        (0, store_1.setCtfRole)(guild.id, ctfKey, role.id);
    }
    // 비공개 카테고리 (참가자 역할만 보임) — 장르 채널들이 이 안에 들어감
    let created = false;
    const catKey = `ctfcat:${ctfKey}`;
    const catId = (0, store_1.getForumFor)(guild.id, catKey);
    let category = catId ? guild.channels.cache.get(catId) ?? (await guild.channels.fetch(catId).catch(() => null)) : null;
    if (!category || category.type !== discord_js_1.ChannelType.GuildCategory) {
        category = await guild.channels.create({
            name: `🚩 ${ctfName}`.slice(0, 95),
            type: discord_js_1.ChannelType.GuildCategory,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
                { id: role.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel] },
                { id: guild.members.me.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ManageChannels, discord_js_1.PermissionFlagsBits.ManageThreads, discord_js_1.PermissionFlagsBits.CreatePublicThreads] },
            ],
        });
        (0, store_1.setForumFor)(guild.id, catKey, category.id);
        created = true;
    }
    for (const [key, name, topic] of CTF_CORE_CHANNELS) {
        await ensureCtfTextChannel(guild, ctfKey, category.id, key, name, topic);
    }
    const oldTime = (0, store_1.getCtfTime)(guild.id, ctfKey);
    const startsAt = options.startsAt ?? oldTime?.startsAt ?? Date.now();
    const endsAt = options.endsAt ?? oldTime?.endsAt ?? startsAt + 24 * 60 * 60 * 1000;
    (0, store_1.setCtfTime)(guild.id, ctfKey, startsAt, endsAt);
    let contest = (0, store_1.getCtfContest)(guild.id, ctfKey);
    if (!contest) {
        contest = {
            guildId: guild.id, key: ctfKey, name: ctfName, roleId: role.id, categoryId: category.id,
            startsAt, endsAt, teamName: options.teamName, allSolved: false, warningEnabled: false,
            createdAt: Date.now(), updatedAt: Date.now(),
        };
        (0, store_1.upsertCtfContest)(contest);
    }
    else {
        contest = (0, store_1.updateCtfContest)(guild.id, ctfKey, {
            name: ctfName, roleId: role.id, categoryId: category.id, startsAt, endsAt,
            teamName: options.teamName ?? contest.teamName,
        });
    }
    if (created || !contest.lobbyMessageId) {
        const lobby = await ensureLobby(guild);
        const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`ctfjoin:${ctfKey}`).setLabel("참가할래요").setEmoji("🙌").setStyle(discord_js_1.ButtonStyle.Success));
        const when = `\n일정: <t:${Math.floor(startsAt / 1000)}:f> ~ <t:${Math.floor(endsAt / 1000)}:f>`;
        const message = await lobby.send({
            content: `다음 대회: **${ctfName}**${when}`,
            components: [row],
        }).catch(() => null);
        if (message)
            contest = (0, store_1.updateCtfContest)(guild.id, ctfKey, { lobbyChannelId: lobby.id, lobbyMessageId: message.id });
    }
    return { categoryId: category.id, roleId: role.id, ctfKey, contest };
}
/** 이미지와 같은 장르 텍스트 채널. 문제는 이 채널의 공개 스레드로 생성한다. */
async function ensureGenreForum(guild, ctfKey, categoryId, _roleId, genre) {
    const normalized = (0, core_1.normalizeCtfCategory)(genre);
    const key = `ctf:${ctfKey}:${normalized}`;
    const existingId = (0, store_1.getForumFor)(guild.id, key);
    if (existingId) {
        const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
        if (ch && ch.type === discord_js_1.ChannelType.GuildText)
            return ch;
    }
    const ch = await guild.channels.create({
        name: `🟦｜${normalized}`.slice(0, 95),
        type: discord_js_1.ChannelType.GuildText,
        parent: categoryId,
        topic: `${normalized} challenge threads`,
    });
    (0, store_1.setForumFor)(guild.id, key, ch.id);
    return ch;
}
async function ensureTags(forum, names) {
    let tags = forum.availableTags;
    const missing = names.filter((n) => !tags.some((t) => t.name === n));
    if (missing.length > 0 && tags.length < 20) {
        const toAdd = missing.slice(0, 20 - tags.length).map((n) => ({ name: n.slice(0, 20) }));
        const updated = await forum.setAvailableTags([
            ...tags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
            ...toAdd,
        ]);
        tags = updated.availableTags;
    }
    return names.map((n) => tags.find((t) => t.name === n.slice(0, 20))?.id).filter((x) => Boolean(x));
}
function textModal(customId, title, label, value) {
    const input = new discord_js_1.TextInputBuilder().setCustomId("value").setLabel(label).setStyle(discord_js_1.TextInputStyle.Short).setRequired(true).setMaxLength(100);
    if (value)
        input.setValue(value);
    return new discord_js_1.ModalBuilder().setCustomId(customId).setTitle(title).addComponents(new discord_js_1.ActionRowBuilder().addComponents(input));
}
function canManage(interaction, authorId) {
    if (interaction.user.id === authorId)
        return true;
    const perms = interaction.memberPermissions;
    return Boolean(perms?.has(discord_js_1.PermissionFlagsBits.Administrator) || perms?.has(discord_js_1.PermissionFlagsBits.ManageChannels));
}
function isAdmin(interaction) {
    const perms = interaction.memberPermissions;
    return Boolean(perms?.has(discord_js_1.PermissionFlagsBits.Administrator) || perms?.has(discord_js_1.PermissionFlagsBits.ManageChannels));
}
function isBotOwner(interaction) {
    const ownerId = BOT_OWNER_ID ?? interaction.guild?.ownerId;
    return Boolean(ownerId && interaction.user.id === ownerId);
}
function ownerOnlyMessage() {
    return BOT_OWNER_ID
        ? "⛔ 이 작업은 BOT_OWNER_ID로 지정된 봇 소유자만 실행할 수 있습니다."
        : "⛔ 이 작업은 서버 소유자만 실행할 수 있습니다. BOT_OWNER_ID를 설정하면 지정 사용자로 고정됩니다.";
}
async function deleteChannelSafe(id) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch)
        return true;
    try {
        await ch.delete();
        return true;
    }
    catch (error) {
        console.warn(`채널 삭제 실패(${id}):`, error instanceof Error ? error.message : error);
        return false;
    }
}
async function resetEventFeature(guild) {
    await eventSyncJobs.get(guild.id)?.catch(() => undefined);
    await sharedCollectionJob?.catch(() => undefined);
    sharedCollection = undefined;
    const items = (0, store_1.getGuildEventItems)(guild.id);
    const keys = [
        ...(0, store_1.getForumKeysFor)(guild.id, "events:"),
        ...(0, store_1.getForumKeysFor)(guild.id, "eventindex:"),
        ...(0, store_1.getForumKeysFor)(guild.id, "eventcat:"),
    ];
    await guild.channels.fetch();
    const categoryNames = new Set([
        ...Object.values(EVENT_KIND_LABELS),
        "CTF 대회 공지",
    ]);
    const categoryIds = new Set(guild.channels.cache
        .filter((channel) => channel.type === discord_js_1.ChannelType.GuildCategory && categoryNames.has(channel.name))
        .map((channel) => channel.id));
    const channelIds = new Set(keys
        .map((key) => (0, store_1.getForumFor)(guild.id, key))
        .filter((id) => Boolean(id)));
    for (const channel of guild.channels.cache.values()) {
        if (channel.parentId && categoryIds.has(channel.parentId))
            channelIds.add(channel.id);
    }
    for (const categoryId of categoryIds)
        channelIds.delete(categoryId);
    let channels = 0;
    let failed = 0;
    const removedIds = new Set();
    for (const channelId of channelIds) {
        if (await deleteChannelSafe(channelId)) {
            channels++;
            removedIds.add(channelId);
        }
        else
            failed++;
    }
    for (const categoryId of categoryIds) {
        if (await deleteChannelSafe(categoryId)) {
            channels++;
            removedIds.add(categoryId);
        }
        else
            failed++;
    }
    for (const key of keys) {
        const channelId = (0, store_1.getForumFor)(guild.id, key);
        if (!channelId || removedIds.has(channelId) || !guild.channels.cache.has(channelId))
            (0, store_1.removeForumFor)(guild.id, key);
    }
    (0, store_1.clearGuildEvents)(guild.id);
    releaseUnusedMemory();
    return { channels, items: items.length, failed };
}
// ── CTF 카드 임베드 / 버튼 ────────────────────────────────────────────
function ctfCard(name, ctfName, genre, authorId) {
    return new discord_js_1.EmbedBuilder()
        .setTitle(`🏴 ${name}`)
        .setColor(0xeb459e)
        .addFields({ name: "CTF", value: ctfName, inline: true }, { name: "장르", value: genre, inline: true }, { name: "등록자", value: `<@${authorId}>`, inline: true })
        .setFooter({ text: "'이거 풀래요' 버튼으로 참여하고, 풀면 이 스레드에서 /ctf solve 를 입력하세요." });
}
function ctfButtonRow(id) {
    return new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`ctftry:${id}`).setLabel("이거 풀래요").setEmoji("🙋").setStyle(discord_js_1.ButtonStyle.Success));
}
function contestForChannel(guildId, channelId, parentId) {
    return (0, store_1.getGuildCtfContests)(guildId).find((contest) => contest.categoryId === channelId || contest.categoryId === parentId);
}
async function ctfCoreChannel(guild, ctfKey, key) {
    const id = (0, store_1.getForumFor)(guild.id, `ctftext:${ctfKey}:${key}`);
    if (!id)
        return null;
    const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
    return channel?.type === discord_js_1.ChannelType.GuildText ? channel : null;
}
function allSolveEmbed(contest, solved, total) {
    return new discord_js_1.EmbedBuilder()
        .setTitle(contest.allSolved ? `🔵 ALL SOLVE · ${contest.name}` : `⚪ ${contest.name}`)
        .setColor(contest.allSolved ? 0x3498db : 0xffffff)
        .setDescription(total === 0
        ? "등록된 문제가 없습니다."
        : `${solved}/${total} challenges solved${contest.allSolved ? "\n현재 공개된 모든 문제를 해결했습니다." : ""}`)
        .setTimestamp();
}
/** 문제 추가/삭제/풀이 때마다 계산하므로 새 문제가 생기면 파란색에서 즉시 흰색으로 돌아간다. */
async function refreshAllSolveStatus(guild, ctfKey) {
    let contest = (0, store_1.getCtfContest)(guild.id, ctfKey);
    if (!contest)
        return false;
    const problems = (0, store_1.getGuildCtfProblems)(guild.id).filter((problem) => problem.ctfKey === ctfKey);
    const allSolved = (0, core_1.isAllSolved)(problems);
    const changed = contest.allSolved !== allSolved;
    contest = (0, store_1.updateCtfContest)(guild.id, ctfKey, { allSolved });
    const channel = await ctfCoreChannel(guild, ctfKey, "solve");
    if (!channel)
        return allSolved;
    const embed = allSolveEmbed(contest, problems.filter((problem) => problem.solved).length, problems.length);
    let message = contest.solveStatusMessageId
        ? await channel.messages.fetch(contest.solveStatusMessageId).catch(() => null)
        : null;
    if (message)
        await message.edit({ embeds: [embed] }).catch(() => { });
    else {
        message = await channel.send({ embeds: [embed] }).catch(() => null);
        if (message)
            (0, store_1.updateCtfContest)(guild.id, ctfKey, { solveStatusMessageId: message.id });
    }
    if (changed && allSolved) {
        const feed = await ctfCoreChannel(guild, ctfKey, "feed");
        await feed?.send(`🔵 **${contest.name} ALL SOLVE!** 현재 공개된 ${problems.length}개 문제를 모두 해결했습니다.`).catch(() => { });
    }
    return allSolved;
}
async function createCtfPost(guild, forum, ctfName, ctfKey, name, genre, authorId, externalId) {
    const id = genId();
    const post = await forum.threads.create({
        name: name.slice(0, 95),
        autoArchiveDuration: discord_js_1.ThreadAutoArchiveDuration.OneWeek,
        type: discord_js_1.ChannelType.PublicThread,
        reason: `CTF 문제 추가: ${name}`,
    });
    await post.send({ embeds: [ctfCard(name, ctfName, genre, authorId)], components: [ctfButtonRow(id)] });
    const rec = {
        id,
        guildId: guild.id,
        ctfName,
        ctfKey,
        name,
        nameKey: (0, store_1.keyOf)(name),
        genre,
        genreKey: (0, store_1.keyOf)(genre),
        forumId: forum.id,
        postId: post.id,
        authorId,
        solves: {},
        solved: false,
        externalId,
        createdAt: Date.now(),
    };
    (0, store_1.addCtfProblem)(rec);
    await refreshAllSolveStatus(guild, ctfKey);
    return rec;
}
// ── 인터랙션 라우팅 ───────────────────────────────────────────────────
client.on(discord_js_1.Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isChatInputCommand())
            return void (await handleCommand(interaction));
        if (interaction.isButton())
            return void (await handleButton(interaction));
        if (interaction.isModalSubmit())
            return void (await handleModal(interaction));
        if (interaction.isStringSelectMenu())
            return void (await handleSelect(interaction));
        if (interaction.isUserSelectMenu())
            return void (await handleUserSelect(interaction));
    }
    catch (err) {
        console.error("인터랙션 처리 오류:", err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "⚠️ 처리 중 오류가 발생했습니다.", flags: discord_js_1.MessageFlags.Ephemeral }).catch(() => { });
        }
    }
});
async function handleCommand(interaction) {
    const name = interaction.commandName;
    if (name === "봇")
        return handleBotCommand(interaction);
    // 꺼진 기능 가드 (보이지 않아야 정상이지만 안전망)
    const feat = COMMAND_FEATURE[name];
    if (feat && interaction.guildId && !(0, store_1.getFeatures)(interaction.guildId).includes(feat)) {
        return interaction.reply({ content: "이 기능은 꺼져 있어요. `/봇 기능 추가` 로 켜주세요.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (name === "문제")
        return handleProblemCommand(interaction);
    if (name === "ctf" || name === "ctf관리")
        return handleCtfCommand(interaction);
    if (name.startsWith("event_"))
        return handleEventCommand(interaction);
    if (name === "로그채널" || name === "로그채널확인")
        return handleLoggingCommand(interaction);
}
// ── /봇 기능 토글 ─────────────────────────────────────────────────────
async function handleBotCommand(interaction) {
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    if (!isBotOwner(interaction))
        return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const enabled = (0, store_1.getFeatures)(interaction.guild.id);
    if (sub === "목록") {
        const lines = Object.entries(FEATURES).map(([k, f]) => `${enabled.includes(k) ? "🟢" : "⚪"} **${f.label}** — ${f.desc}`);
        const embed = new discord_js_1.EmbedBuilder().setTitle("🤖 봇 기능").setColor(0x5865f2).setDescription(lines.join("\n"));
        return interaction.reply({ embeds: [embed], flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "추가") {
        const off = Object.entries(FEATURES).filter(([k]) => !enabled.includes(k));
        if (off.length === 0)
            return interaction.reply({ content: "이미 모든 기능이 켜져 있어요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId("feat_add")
            .setPlaceholder("켤 기능을 고르세요 (여러 개 가능)")
            .setMinValues(1)
            .setMaxValues(off.length)
            .addOptions(off.map(([k, f]) => ({ label: f.label, value: k, description: f.desc.slice(0, 100) })));
        return interaction.reply({
            content: "켤 기능을 선택하세요. 선택하면 해당 명령어가 보이게 됩니다.",
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (sub === "삭제") {
        if (enabled.length === 0)
            return interaction.reply({ content: "켜진 기능이 없어요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId("feat_del")
            .setPlaceholder("끌 기능을 고르세요")
            .setMinValues(1)
            .setMaxValues(enabled.length)
            .addOptions(enabled.map((k) => ({ label: FEATURES[k]?.label ?? k, value: k })));
        return interaction.reply({
            content: "끌 기능을 선택하세요. 해당 명령어가 숨겨집니다.",
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
}
// ── 로그 기능 (discord-bot 포팅) ──────────────────────────────────────
function findLogChannel(guild) {
    const saved = (0, store_1.getLogChannel)(guild.id);
    if (saved) {
        const ch = guild.channels.cache.get(saved);
        if (ch?.isSendable())
            return ch;
    }
    const guess = guild.channels.cache.find((ch) => ch.isTextBased() && /log|로그|welcome|입장|general|일반/i.test(ch.name));
    if (guess?.isSendable())
        return guess;
    return guild.systemChannel?.isSendable() ? guild.systemChannel : null;
}
async function handleLoggingCommand(interaction) {
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    if (!isBotOwner(interaction))
        return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
    if (interaction.commandName === "로그채널") {
        const channel = interaction.options.getChannel("채널", true);
        if (!("isTextBased" in channel) || !channel.isTextBased()) {
            return interaction.reply({ content: "❌ 텍스트 채널만 설정할 수 있어요!", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        (0, store_1.setLogChannel)(interaction.guild.id, channel.id);
        await cacheInvites(interaction.guild);
        return interaction.reply({ content: `✅ 로그 채널이 <#${channel.id}> 로 설정됐어요!`, flags: discord_js_1.MessageFlags.Ephemeral });
    }
    // 로그채널확인
    const saved = (0, store_1.getLogChannel)(interaction.guild.id);
    if (!saved)
        return interaction.reply({ content: "❌ 설정된 로그 채널이 없어요. `/로그채널 #채널` 로 설정하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
    return interaction.reply({ content: `📌 현재 로그 채널: <#${saved}>`, flags: discord_js_1.MessageFlags.Ephemeral });
}
// ── 보안뉴스 / 행사 공지 기능 (ctf-discord-bot 포팅 시작점) ──────────
// kind: "news" = 그 피드 항목은 무조건 뉴스로 취급 (CTF/행사 채널로 새지 않게).
//       "event" = 행사 발굴용 — 진짜 행사 공지만 추리고 결과/소식성 기사는 버린다.
const DEFAULT_EVENT_FEEDS = [
    { url: "https://news.google.com/rss/search?q=%EC%A0%95%EB%B3%B4%EB%B3%B4%EC%95%88%20OR%20%EC%B7%A8%EC%95%BD%EC%A0%90%20OR%20%EB%9E%9C%EC%84%AC%EC%9B%A8%EC%96%B4&hl=ko&gl=KR&ceid=KR:ko", kind: "news" },
    { url: "https://news.google.com/rss/search?q=CTF%20OR%20%ED%95%B4%ED%82%B9%EB%B0%A9%EC%96%B4%EB%8C%80%ED%9A%8C%20OR%20%EB%B3%B4%EC%95%88%20%ED%95%B4%EC%BB%A4%ED%86%A4%20OR%20%EB%B3%B4%EC%95%88%20%EC%BB%A8%ED%8D%BC%EB%9F%B0%EC%8A%A4&hl=ko&gl=KR&ceid=KR:ko", kind: "event" },
    { url: "https://news.google.com/rss/search?q=%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8%20%EA%B3%B5%EB%AA%A8%EC%A0%84%20OR%20%EC%82%AC%EC%9D%B4%EB%B2%84%EB%B3%B4%EC%95%88%20%EA%B5%90%EC%9C%A1%20OR%20%EB%B3%B4%EC%95%88%20%EC%BA%A0%ED%94%84&hl=ko&gl=KR&ceid=KR:ko", kind: "event" },
    { url: "https://www.boannews.com/media/news_rss.xml?mkind=1", kind: "news" },
];
const DEFAULT_EVENT_PAGES = [
    { name: "K-CTF", url: "https://kctf.kr/" },
    { name: "DACON", url: "https://dacon.io/competitions" },
    { name: "CODEGATE", url: "https://codegate.org/" },
    { name: "SECON", url: "https://www.seconexpo.com/" },
    { name: "KISA", url: "https://www.kisa.or.kr/" },
    { name: "KISIA", url: "https://www.kisia.or.kr/" },
    { name: "보안뉴스", url: "https://www.boannews.com/" },
    { name: "WACON", url: "https://wacon.world/" },
    { name: "한국코드페어", url: "https://www.kcf.or.kr/" },
    { name: "정보보호영재교육원", url: "https://gifted.korea.ac.kr/" },
    { name: "국가사이버안보센터", url: "https://www.ncsc.go.kr/" },
];
const EVENT_KIND_LABELS = {
    ctf: "CTF 대회",
    ai: "AI 경진대회",
    conference: "국내 보안 컨퍼런스",
    hackathon: "국내 해커톤",
    security: "기타 정보보안",
    news: "정보보안 소식",
};
const EVENT_BUCKET_LABELS = {
    within_1m: "1개월-이내",
    within_2m: "2개월-이내",
    later: "그-외",
    final: "본선",
    ended: "종료",
    unknown: "날짜-미정",
    latest: "최신-소식",
};
const EVENT_BUCKETS_BY_KIND = {
    ctf: ["within_1m", "within_2m", "later", "final", "ended"],
    ai: ["within_1m", "within_2m", "later", "final", "ended"],
    conference: ["within_1m", "within_2m", "later", "ended"],
    hackathon: ["within_1m", "within_2m", "later", "final", "ended"],
    security: ["within_1m", "within_2m", "later", "ended"],
    news: ["latest"],
};
const EVENT_SOURCE_PRIORITY = {
    Manual: 0,
    Direct: 0,
    HSPACE: 0,
    "K-CTF": 1,
    CTFtime: 2,
    DACON: 3,
    공일: 4,
    CODEGATE: 4,
    SECON: 4,
    한국코드페어: 4,
    한국정보보호학회: 4,
    "국가정보원 보안대회": 4,
    WACON: 4,
    "KISIA 교육": 5,
    "KISIA 유관기관": 5,
    "KISA 정보보안 소식": 5,
    보안뉴스: 5,
    "검색API-보안뉴스": 6,
};
function eventForumKey(item) {
    const kind = item.kind ?? "security";
    if (kind === "news")
        return "events:news:latest";
    return `events:${kind}:bucket:${item.bucket ?? "unknown"}`;
}
function eventForumKeyFor(kind, bucket) {
    if (kind === "news")
        return "events:news:latest";
    return `events:${kind}:bucket:${bucket}`;
}
function eventFeedUrls() {
    const extra = (process.env.EVENT_FEED_URLS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((url) => ({ url, kind: "event" }));
    return [...DEFAULT_EVENT_FEEDS, ...extra];
}
function eventPageSources() {
    const extra = (process.env.EVENT_PAGE_URLS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((url) => ({ name: new URL(url).hostname, url }));
    const defaults = DEFAULT_EVENT_PAGES.filter((source) => source.name !== "K-CTF" || envBool("ENABLE_KCTF", true));
    return [...defaults, ...extra];
}
function decodeXml(input) {
    return input
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .trim();
}
function stripHtml(input) {
    return decodeXml(input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}
function normalizeWhitespace(input) {
    return decodeXml(input).replace(/\s+/g, " ").trim();
}
function labelValue(text, labels) {
    for (const raw of text.split(/\r?\n| {2,}/)) {
        const line = normalizeWhitespace(raw);
        if (!labels.test(line))
            continue;
        const value = line.split(/[:：]| - /).slice(1).join(":").trim();
        if (value)
            return value.slice(0, 300);
        if (line.length <= 120)
            return line.slice(0, 300);
    }
    return undefined;
}
function enrichEventDetails(item, text) {
    const clean = normalizeWhitespace(text);
    item.organizer ??= labelValue(text, /^(주최|주관|운영|host|organizer)/i);
    item.eligibility ??= labelValue(text, /^(참가\s*대상|참가\s*자격|대상|eligibility|target)/i);
    item.registration ??= labelValue(text, /^(모집|신청|접수|등록|사전\s*등록|registration)/i);
    item.location ??= labelValue(text, /^(장소|위치|개최\s*장소|진행\s*장소|location|venue)/i);
    item.teamLimit ??= labelValue(text, /^(팀\s*(구성|인원|제한)|참가\s*인원|인원\s*제한|team)/i);
    item.participationMode ??= participationMode(clean, item.location);
}
function participationMode(text, location) {
    const combined = `${text} ${location ?? ""}`;
    const online = /\bonline\b|온라인|비대면|remote|virtual/i.test(combined);
    const offline = /\boffline\b|오프라인|대면|현장|서울|부산|대전|인천|광주|대구|제주|코엑스|coex|대학교|센터/i.test(combined);
    if (online && offline)
        return "온·오프라인 병행";
    if (online)
        return "온라인";
    if (offline)
        return "오프라인";
    return "정보 없음";
}
function tagValue(xml, tag) {
    return decodeXml(xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "");
}
function attrValue(html, attr) {
    return decodeXml(html.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? "");
}
function absoluteUrl(base, href) {
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:"))
        return null;
    try {
        return new URL(decodeXml(href), base).toString();
    }
    catch {
        return null;
    }
}
function eventId(link, title) {
    return (0, node_crypto_1.createHash)("sha1").update(link || title).digest("hex").slice(0, 16);
}
function normalizedEventTitle(title) {
    return title
        .replace(/\[[^\]]+\]/g, " ")
        .replace(/\([^)]*(?:종합|속보|단독|포토|영상|그래픽|보도자료)[^)]*\)/g, " ")
        .replace(/["'“”‘’]/g, "")
        .replace(/\s*[-|:]\s*(?:보안뉴스|데일리시큐|전자신문|아이뉴스24|ZDNET Korea|지디넷코리아|연합뉴스|뉴스1|뉴시스|매일경제|한국경제|이데일리|파이낸셜뉴스).*$/i, "")
        .replace(/[^a-z0-9가-힣]+/gi, "")
        .toLowerCase();
}
function eventDedupeKey(item) {
    return (0, core_2.eventDedupeKey)(item);
}
function isUsefulEventItem(title, summary) {
    const text = `${title} ${summary}`.toLowerCase();
    return /ctf|해킹방어|사이버공격방어|정보보안|정보보호|보안|취약점|랜섬웨어|해커톤|컨퍼런스|kisa|침해사고|악성코드|제로데이|공모전|교육|캠프|세미나|대회|경진대회|codegate|secon|wacon|dacon|데이콘/i.test(text);
}
function isSecurityNews(title, summary) {
    return /취약점|침해사고|랜섬웨어|악성코드|보안패치|제로데이|CVE|해킹|개인정보|유출|사이버공격|보안뉴스|위협/i.test(`${title} ${summary}`);
}
function looksLikeResultNews(title, summary) {
    return /수상|입상|최우수상|우수상|장려상|대상|성과|성료|마무리|개최\s*(?:결과|성과)|시상식|차지|선정/i.test(`${title} ${summary}`);
}
function classifyEvent(title, summary) {
    return (0, core_2.classifyEvent)(title, summary);
}
function isEventAnnouncement(title, summary) {
    const text = `${title} ${summary}`;
    return /대회|경진대회|해커톤|컨퍼런스|세미나|포럼|교육|캠프|공모전|모집|접수|참가|신청|개최|일정|안내|예선|본선|결승|CTF|CODEGATE|SECON|WACON|DACON/i.test(text);
}
function shouldPublishAutoEvent(item) {
    const now = Date.now();
    if (item.kind === "news")
        return item.publishedAt >= now - 30 * 86400000 && isSecurityNews(item.title, item.summary ?? "");
    if (looksLikeResultNews(item.title, item.summary ?? ""))
        return false;
    // 이미 끝난 행사는 새로 올리지 않음 (원본 봇과 동일 — 진행 예정/진행 중만 게시)
    if (item.endsAt && item.endsAt < now)
        return false;
    // 종료 시각을 모르면 시작 시각 기준: 12시간 넘게 지난 건 제외
    if (!item.endsAt) {
        if (!item.startsAt)
            return false;
        if (item.startsAt < now - 12 * 3600000)
            return false;
    }
    if (!item.source.startsWith("검색API") && !item.source.startsWith("자동탐색"))
        return true;
    return isEventAnnouncement(item.title, item.summary ?? "");
}
/** 종류별(CTF→AI→…→뉴스) 라운드로빈으로 섞어, 뉴스가 CTF를 굶기지 않게 한다. (원본 봇 interleave) */
const EVENT_KIND_ORDER = ["ctf", "ai", "conference", "hackathon", "security", "news"];
function interleaveEvents(events) {
    const dateKey = (e) => e.startsAt ?? e.endsAt ?? e.publishedAt ?? Number.MAX_SAFE_INTEGER;
    const queues = EVENT_KIND_ORDER.map((kind) => events.filter((e) => (e.kind ?? "security") === kind).sort((a, b) => dateKey(a) - dateKey(b)));
    const other = events.filter((e) => !EVENT_KIND_ORDER.includes(e.kind ?? "security")).sort((a, b) => dateKey(a) - dateKey(b));
    queues.push(other);
    const ordered = [];
    let i = 0;
    let drained = false;
    while (!drained) {
        drained = true;
        for (const q of queues) {
            if (i < q.length) {
                ordered.push(q[i]);
                drained = false;
            }
        }
        i++;
    }
    return ordered;
}
function looksMostlyEnglish(input) {
    const letters = input.match(/[A-Za-z]/g)?.length ?? 0;
    const korean = input.match(/[가-힣]/g)?.length ?? 0;
    return letters > 20 && letters > korean * 2;
}
function translatedHint(item) {
    if (!envBool("ENABLE_TRANSLATION", false))
        return undefined;
    if (!looksMostlyEnglish(`${item.title} ${item.summary ?? ""}`))
        return undefined;
    const kind = EVENT_KIND_LABELS[item.kind ?? "security"] ?? "보안 행사";
    const when = item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정";
    return `자동 분류: ${kind} · 일정: ${when}`;
}
function extractDateMs(text) {
    const nowYear = new Date().getFullYear();
    const patterns = [
        /((?:20)?\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/g,
        /(\d{1,2})[.\-/월]\s*(\d{1,2})/g,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text))) {
            const year = m.length === 4 ? Number(m[1].length === 2 ? `20${m[1]}` : m[1]) : nowYear;
            const month = Number(m.length === 4 ? m[2] : m[1]);
            const day = Number(m.length === 4 ? m[3] : m[2]);
            const dt = new Date(year, month - 1, day, 9, 0, 0);
            if (dt.getMonth() === month - 1 && dt.getDate() === day)
                return dt.getTime();
        }
    }
    return undefined;
}
function bucketForEvent(item) {
    return (0, core_2.bucketForEvent)(item);
}
async function fetchEventFeed(url, feedKind = "event") {
    const res = await fetch(url, { headers: { "User-Agent": "discord-ctf-bot/1.0" } });
    if (!res.ok)
        throw new Error(`RSS 응답 실패 ${res.status}`);
    const xml = await res.text();
    const source = tagValue(xml, "title") || new URL(url).hostname;
    const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
    const out = [];
    for (const block of blocks) {
        const title = stripHtml(tagValue(block, "title"));
        const link = tagValue(block, "link");
        const summary = stripHtml(tagValue(block, "description"));
        if (!title || !link || !isUsefulEventItem(title, summary))
            continue;
        const pubDate = Date.parse(tagValue(block, "pubDate") || tagValue(block, "updated"));
        const publishedAt = Number.isFinite(pubDate) ? pubDate : Date.now();
        const startsAt = extractDateMs(`${title} ${summary}`);
        // 뉴스 피드 항목은 무조건 뉴스로 — 제목에 CTF가 있어도 대회 채널로 새지 않게.
        let kind;
        if (feedKind === "news") {
            kind = "news";
        }
        else {
            // 행사 발굴 피드: 결과/소식성 기사는 대회로 보지 않고, 행사 공지 신호가 없으면 버린다.
            if (looksLikeResultNews(title, summary))
                continue;
            kind = classifyEvent(title, summary);
            if (kind === "news")
                continue; // 행사 신호가 없으면 행사 채널에 올리지 않음
        }
        const item = {
            id: eventId(link, title),
            guildId: "",
            title,
            link,
            source: stripHtml(source).replace(/^"|"$/g, ""),
            kind,
            summary,
            publishedAt,
            startsAt,
            bucket: bucketForEvent({ kind, title, startsAt, publishedAt }),
        };
        enrichEventDetails(item, `${title}\n${summary}`);
        out.push(item);
    }
    return out;
}
async function fetchCtftimeRange(start, finish, limit) {
    const res = await fetch(`https://ctftime.org/api/v1/events/?limit=${limit}&start=${start}&finish=${finish}`, {
        headers: { "User-Agent": "discord-ctf-bot/1.0 (+Discord CTF event aggregator)" },
    });
    if (!res.ok)
        throw new Error(`CTFtime 응답 실패 ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
}
async function fetchCtftimeEvents() {
    const now = Math.floor(Date.now() / 1000);
    const lookaheadDays = Math.max(30, Number(process.env.LOOKAHEAD_DAYS ?? 365) || 365);
    // 원본 봇과 동일: 진행 중/방금 시작한 대회까지 잡으려고 두 구간을 합친다.
    //  - 미래: now-12h ~ now+lookahead (진행 중인 CTF 포함)
    //  - 최근: now-14d ~ now (막 끝난 CTF 포함)
    const [futureRows, recentRows] = await Promise.all([
        fetchCtftimeRange(now - 12 * 3600, now + lookaheadDays * 86400, 200),
        fetchCtftimeRange(now - 14 * 86400, now, 100),
    ]);
    const byId = new Map();
    for (const row of [...recentRows, ...futureRows])
        byId.set(String(row?.id), row);
    return [...byId.values()]
        .map((event) => {
        const title = String(event.title ?? "").trim();
        const link = String(event.url || event.ctftime_url || "").trim();
        const startsAt = Date.parse(event.start);
        const endsAt = Date.parse(event.finish);
        const publishedAt = Number.isFinite(startsAt) ? startsAt : Date.now();
        const organizers = Array.isArray(event.organizers)
            ? event.organizers.map((org) => org?.name).filter(Boolean).join(", ")
            : "";
        const location = event.location ? String(event.location) : undefined;
        const description = event.description ? stripHtml(String(event.description)) : "";
        const item = {
            id: eventId(link || String(event.id), `ctftime:${event.id}:${title}`),
            guildId: "",
            title,
            link: link || String(event.ctftime_url || "https://ctftime.org/event/list/"),
            source: "CTFtime",
            kind: "ctf",
            summary: description,
            publishedAt,
            startsAt: Number.isFinite(startsAt) ? startsAt : undefined,
            endsAt: Number.isFinite(endsAt) ? endsAt : undefined,
            organizer: organizers || undefined,
            location,
            participationMode: participationMode(`${event.format ?? ""} ${description}`, location),
            genres: Array.isArray(event.categories) ? event.categories.map((x) => String(x?.name ?? x)).filter(Boolean) : undefined,
        };
        item.bucket = bucketForEvent(item);
        return item;
    })
        .filter((item) => item.title && item.link);
}
async function fetchEventPage(source) {
    const res = await fetch(source.url, { headers: { "User-Agent": "discord-ctf-bot/1.0" } });
    if (!res.ok)
        throw new Error(`HTML 응답 실패 ${res.status}`);
    const html = await res.text();
    const items = [];
    const seen = new Set();
    const anchors = [...html.matchAll(/<a\b[\s\S]*?<\/a>/gi)].slice(0, 400);
    for (const match of anchors) {
        const block = match[0];
        const href = attrValue(block, "href");
        const link = absoluteUrl(source.url, href);
        if (!link || seen.has(link))
            continue;
        seen.add(link);
        const title = stripHtml(block).replace(/\[[^\]]*\]/g, "").trim();
        if (title.length < 4 || title.length > 180)
            continue;
        const idx = Math.max(0, match.index ?? 0);
        const context = stripHtml(html.slice(Math.max(0, idx - 500), Math.min(html.length, idx + block.length + 500)));
        if (!isUsefulEventItem(title, context))
            continue;
        const startsAt = extractDateMs(`${title} ${context}`);
        const kind = classifyEvent(`${source.name} ${title}`, context);
        const publishedAt = startsAt ?? Date.now();
        const item = {
            id: eventId(link, `${source.name}:${title}`),
            guildId: "",
            title,
            link,
            source: source.name,
            kind,
            summary: normalizeWhitespace(context).slice(0, 700),
            publishedAt,
            startsAt,
        };
        enrichEventDetails(item, context);
        item.bucket = bucketForEvent(item);
        items.push(item);
    }
    const pageTitle = stripHtml(tagValue(html, "title"));
    if (isUsefulEventItem(pageTitle, html)) {
        const startsAt = extractDateMs(html);
        const kind = classifyEvent(`${source.name} ${pageTitle}`, html);
        const item = {
            id: eventId(source.url, `${source.name}:${pageTitle}`),
            guildId: "",
            title: pageTitle || source.name,
            link: source.url,
            source: source.name,
            kind,
            summary: stripHtml(html).slice(0, 700),
            publishedAt: startsAt ?? Date.now(),
            startsAt,
        };
        enrichEventDetails(item, html);
        item.bucket = bucketForEvent(item);
        items.push(item);
    }
    return items;
}
async function fetchSingleEventUrl(url) {
    const source = { name: new URL(url).hostname, url };
    const items = await fetchEventPage(source);
    return items[0] ?? null;
}
async function fetchNaverSearchEvents() {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret)
        return [];
    if (process.env.ENABLE_SEARCH_API_DISCOVERY === "false")
        return [];
    const maxResults = Math.min(100, Math.max(10, Number(process.env.SEARCH_API_MAX_RESULTS ?? 30) || 30));
    const queries = [
        { name: "검색API-CTF", query: "CTF 대회 모집 OR 해킹방어대회 접수 OR 사이버공격방어대회", kind: "ctf", requireDate: true },
        { name: "검색API-CTF-해외", query: "CTF competition registration cybersecurity challenge", kind: "ctf", requireDate: true },
        { name: "검색API-AI대회", query: "AI 경진대회 모집 OR 인공지능 공모전 OR 데이터 경진대회 접수", kind: "ai", requireDate: true },
        { name: "검색API-AI보안", query: "AI 보안 해커톤 OR AI security hackathon OR 사이버보안 AI 경진대회", kind: "ai", requireDate: true },
        { name: "검색API-해커톤", query: "정보보안 해커톤 모집 OR 사이버보안 해커톤 참가", kind: "hackathon", requireDate: true },
        { name: "검색API-컨퍼런스", query: "정보보안 컨퍼런스 OR 사이버보안 세미나 OR 보안 포럼", kind: "conference", requireDate: true },
        { name: "검색API-고등학생보안", query: "고등학생 정보보안 모집 OR 고등학교 사이버보안 캠프 OR 청소년 보안 경진대회 접수", kind: "security", requireDate: true },
        { name: "검색API-보안뉴스", query: "정보보안 취약점 랜섬웨어 침해사고 보안패치", kind: "news", requireDate: false },
    ];
    const out = [];
    for (const query of queries) {
        for (const api of [
            { endpoint: "webkr.json", source: "Naver Web", dated: false },
            { endpoint: "news.json", source: "Naver News", dated: true },
        ]) {
            const url = new URL(`https://openapi.naver.com/v1/search/${api.endpoint}`);
            url.searchParams.set("query", query.query);
            url.searchParams.set("display", String(Math.min(maxResults, 100)));
            url.searchParams.set("sort", api.dated ? "date" : "sim");
            const res = await fetch(url, {
                headers: {
                    "X-Naver-Client-Id": clientId,
                    "X-Naver-Client-Secret": clientSecret,
                    "User-Agent": "discord-ctf-bot/1.0",
                },
            });
            if (!res.ok)
                throw new Error(`Naver ${api.source} 응답 실패 ${res.status}`);
            const json = await res.json();
            for (const row of Array.isArray(json?.items) ? json.items : []) {
                const title = stripHtml(String(row.title ?? ""));
                const summary = stripHtml(String(row.description ?? ""));
                const link = String(row.originallink || row.link || "");
                if (!title || !link || !isUsefulEventItem(title, summary))
                    continue;
                const pubDate = Date.parse(String(row.pubDate ?? ""));
                const startsAt = extractDateMs(`${title} ${summary}`);
                const kind = query.kind;
                if (kind === "news") {
                    if (!isSecurityNews(title, summary))
                        continue;
                    if (Number.isFinite(pubDate) && pubDate < Date.now() - 30 * 86400000)
                        continue;
                }
                else {
                    if (query.requireDate && !startsAt)
                        continue;
                    if (startsAt && startsAt < Date.now() - 3 * 86400000)
                        continue;
                    if (!isEventAnnouncement(title, summary) || looksLikeResultNews(title, summary))
                        continue;
                }
                const item = {
                    id: eventId(link, `naver:${query.name}:${api.source}:${title}`),
                    guildId: "",
                    title,
                    link,
                    source: query.name,
                    kind,
                    summary,
                    publishedAt: Number.isFinite(pubDate) ? pubDate : Date.now(),
                    startsAt: kind === "news" ? (Number.isFinite(pubDate) ? pubDate : Date.now()) : startsAt,
                };
                enrichEventDetails(item, `${title}\n${summary}`);
                item.bucket = bucketForEvent(item);
                out.push(item);
            }
        }
    }
    return out;
}
async function ensureEventForum(guild, item) {
    const kind = item.kind ?? "security";
    const bucket = kind === "news" ? "latest" : item.bucket ?? "unknown";
    return ensureEventForumFor(guild, kind, bucket);
}
async function ensureEventForumFor(guild, kind, bucket) {
    const kindLabel = EVENT_KIND_LABELS[kind] ?? "보안 행사";
    const categoryId = await ensureEventCategory(guild, kind);
    const key = eventForumKeyFor(kind, bucket);
    const existingId = (0, store_1.getForumFor)(guild.id, key);
    if (existingId) {
        const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
        if (ch && ch.type === discord_js_1.ChannelType.GuildForum)
            return ch;
    }
    if (kind === "news") {
        const ch = await guild.channels.create({
            name: EVENT_BUCKET_LABELS.latest,
            type: discord_js_1.ChannelType.GuildForum,
            parent: categoryId,
            topic: `${kindLabel} 최신 소식`,
            defaultSortOrder: discord_js_1.SortOrderType.CreationDate,
        });
        (0, store_1.setForumFor)(guild.id, key, ch.id);
        return ch;
    }
    const bucketLabel = EVENT_BUCKET_LABELS[bucket] ?? bucket;
    const ch = await guild.channels.create({
        name: bucketLabel,
        type: discord_js_1.ChannelType.GuildForum,
        parent: categoryId,
        topic: `${kindLabel} · ${bucketLabel}`,
        defaultSortOrder: discord_js_1.SortOrderType.CreationDate,
    });
    (0, store_1.setForumFor)(guild.id, key, ch.id);
    return ch;
}
async function ensureEventForums(guild) {
    for (const kind of Object.keys(EVENT_KIND_LABELS)) {
        const buckets = EVENT_BUCKETS_BY_KIND[kind] ?? ["within_1m", "within_2m", "later"];
        for (const bucket of buckets)
            await ensureEventForumFor(guild, kind, bucket);
    }
}
async function ensureEventCategory(guild, kind) {
    const label = EVENT_KIND_LABELS[kind] ?? "보안 행사";
    const key = `eventcat:${kind}`;
    const existingId = (0, store_1.getForumFor)(guild.id, key);
    if (existingId) {
        const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
        if (ch && ch.type === discord_js_1.ChannelType.GuildCategory)
            return ch.id;
    }
    const ch = await guild.channels.create({
        name: label.slice(0, 95),
        type: discord_js_1.ChannelType.GuildCategory,
    });
    (0, store_1.setForumFor)(guild.id, key, ch.id);
    return ch.id;
}
async function createEventPost(guild, item, updated = false) {
    const forum = await ensureEventForum(guild, item);
    const post = await forum.threads.create({
        name: eventPostTitle(item),
        message: { embeds: [eventEmbed(item, updated)] },
        reason: `보안뉴스/행사 등록: ${item.title}`,
    });
    const starter = await post.fetchStarterMessage().catch(() => null);
    return { threadId: post.id, messageId: starter?.id ?? post.id };
}
async function upsertEventItem(guild, item) {
    const next = { ...item, guildId: guild.id };
    next.kind = next.kind ?? classifyEvent(next.title, next.summary ?? "");
    next.startsAt = next.startsAt ?? (next.kind === "news" ? next.publishedAt : extractDateMs(`${next.title} ${next.summary ?? ""}`));
    next.bucket = bucketForEvent(next);
    const dedupeKey = eventDedupeKey(next);
    const existing = (0, store_1.getEventItem)(guild.id, next.id) ?? (0, store_1.getGuildEventItems)(guild.id).find((saved) => eventDedupeKey(saved) === dedupeKey);
    const destination = eventForumKey(next);
    const contentHash = (0, core_2.eventContentHash)(next);
    if (!existing) {
        const posted = await createEventPost(guild, next);
        (0, store_1.addEventItem)({ ...next, ...posted, destination, contentHash, postedAt: Date.now() });
        return "created";
    }
    const oldDestination = existing.destination ?? eventForumKey(existing);
    const threadId = existing.threadId ?? existing.messageId;
    if (existing.contentHash === contentHash && oldDestination === destination && threadId) {
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (thread?.isThread()) {
            if (thread.archived)
                await thread.setArchived(false).catch(() => { });
            if (thread.name !== eventPostTitle(next))
                await thread.setName(eventPostTitle(next)).catch(() => { });
            (0, store_1.updateEventItem)(guild.id, existing.id, { ...existing, ...next, destination, contentHash, threadId });
            return "unchanged";
        }
    }
    if (oldDestination !== destination || !threadId) {
        if (threadId)
            await deleteChannelSafe(threadId);
        const posted = await createEventPost(guild, next, Boolean(existing.contentHash));
        (0, store_1.updateEventItem)(guild.id, existing.id, { ...next, ...posted, destination, contentHash, postedAt: Date.now() });
        return existing.contentHash ? "updated" : "created";
    }
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread?.isThread()) {
        if (thread.archived)
            await thread.setArchived(false).catch(() => { });
        if (thread.name !== eventPostTitle(next))
            await thread.setName(eventPostTitle(next)).catch(() => { });
        const message = await thread.messages.fetch(existing.messageId ?? thread.id).catch(() => null);
        if (message) {
            await message.edit({ embeds: [eventEmbed(next, true)] });
            (0, store_1.updateEventItem)(guild.id, existing.id, {
                ...existing,
                ...next,
                destination,
                contentHash,
                threadId,
                messageId: message.id,
            });
            return "updated";
        }
    }
    if (threadId)
        await deleteChannelSafe(threadId);
    const posted = await createEventPost(guild, next, true);
    (0, store_1.updateEventItem)(guild.id, existing.id, { ...next, ...posted, destination, contentHash, postedAt: Date.now() });
    return "updated";
}
async function publishEventItem(guild, item) {
    return (await upsertEventItem(guild, item)) === "created";
}
function eventPostTitle(item) {
    const day = (0, core_2.eventDateLabel)(item);
    const region = eventRegion(item);
    const label = item.kind === "ctf"
        ? region === "kr"
            ? "한국 CTF"
            : "해외 CTF"
        : item.kind === "ai"
            ? "AI 경진대회"
            : item.kind === "hackathon"
                ? region === "kr"
                    ? "국내 해커톤"
                    : "해외 해커톤"
                : item.kind === "conference"
                    ? "국내 컨퍼런스"
                    : item.kind === "news"
                        ? "정보보안 소식"
                        : "기타 정보보안";
    return `${day} [${label}] ${item.title}`.slice(0, 95);
}
function eventRegion(item) {
    return (0, core_2.eventRegion)(item);
}
function eventEmbed(item, updated = false) {
    const missing = "명시되어 있지 않음";
    const isConference = item.kind === "conference";
    const isOther = item.kind === "security";
    const isNews = item.kind === "news";
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`${updated ? "[정보 갱신] " : ""}${item.title}`.slice(0, 256))
        .setColor(updated ? 0xf59f00 : 0x5865f2)
        .setTimestamp(item.publishedAt);
    if (item.link)
        embed.setURL(item.link);
    const description = item.summary?.slice(0, 350) ?? "";
    if (description)
        embed.setDescription(description);
    if (isNews) {
        embed.addFields({ name: "소식", value: item.title || missing, inline: false }, { name: "게시일", value: formatDiscordTime(item.startsAt ?? item.publishedAt), inline: false }, { name: "원문 링크", value: item.link || missing, inline: false });
        embed.setFooter({ text: `출처: ${item.source}` });
        return embed;
    }
    embed.addFields({ name: isOther ? "프로그램명" : isConference ? "행사명" : "대회명", value: item.title || missing, inline: false }, { name: "주최 기관", value: item.organizer || missing, inline: true }, { name: "참가 대상", value: item.eligibility || missing, inline: true }, {
        name: isOther ? "모집 일정" : isConference ? "사전 등록 일정" : "모집 및 접수 일정",
        value: item.registration || (item.registrationDeadline ? `접수 마감: ${formatDiscordTime(item.registrationDeadline)}` : missing),
        inline: false,
    });
    if (item.startsAt) {
        embed.addFields({
            name: isOther ? "교육 일정" : isConference ? "행사 일정" : "대회 일정",
            value: item.endsAt ? `${formatDiscordTime(item.startsAt)} ~ ${formatDiscordTime(item.endsAt)}` : formatDiscordTime(item.startsAt),
            inline: false,
        });
    }
    if (item.genres?.length && !isConference && !isOther)
        embed.addFields({ name: "분야", value: item.genres.join(" · "), inline: false });
    if (item.teamLimit && !isConference && !isOther)
        embed.addFields({ name: "팀 제한", value: item.teamLimit, inline: true });
    embed.addFields({ name: "진행 방식", value: item.participationMode || "정보 없음", inline: true });
    if (item.location)
        embed.addFields({ name: "장소", value: item.location, inline: true });
    embed.addFields({ name: isOther ? "안내 링크" : isConference ? "행사 링크" : "대회 링크", value: item.registrationUrl || item.link || missing, inline: false });
    if (item.posterUrl)
        embed.setImage(item.posterUrl);
    embed.setFooter({ text: `출처: ${item.source}` });
    return embed;
}
function formatDiscordTime(ms) {
    return `<t:${Math.floor(ms / 1000)}:f>`;
}
async function syncEvents(guild) {
    const running = eventSyncJobs.get(guild.id);
    if (running)
        return running;
    const job = synchronizeEvents(guild);
    eventSyncJobs.set(guild.id, job);
    try {
        return await job;
    }
    finally {
        eventSyncJobs.delete(guild.id);
    }
}
async function synchronizeEvents(guild) {
    const collectorOptions = (0, sources_1.optionsFromEnv)();
    const collected = await collectEventsShared(collectorOptions);
    const errors = [...collected.errors];
    let saved = (0, store_1.getGuildEventItems)(guild.id);
    for (const item of saved) {
        if (item.kind === "news")
            continue;
        const editorial = (0, sources_1.isEditorialUrl)(item.link) || Boolean(item.registrationUrl && (0, sources_1.isEditorialUrl)(item.registrationUrl));
        const discoveryItem = /검색API|자동탐색|Google 뉴스/i.test(item.source);
        const validTitle = (0, sources_1.searchTitleMatchesKind)((item.kind ?? "security"), item.title);
        const validYear = (0, sources_1.titleYearMatchesEvent)(item.title, item);
        if (!editorial && validYear && (!discoveryItem || validTitle))
            continue;
        const deleted = await deleteChannelSafe(item.threadId ?? item.messageId ?? "");
        if (!deleted) {
            errors.push(`오탐 게시물 삭제 실패: ${item.title}`);
            continue;
        }
        (0, store_1.removeEventItem)(guild.id, item.id);
    }
    saved = (0, store_1.getGuildEventItems)(guild.id);
    const savedByDedupe = new Map(saved.map((item) => [eventDedupeKey(item), item]));
    const savedIds = new Set(saved.map((item) => item.id));
    const candidates = [...collected.items];
    // 한 번 게시된 행사는 소스 목록에서 일시적으로 사라져도 기간 포럼 이동과
    // 종료 보관이 계속 동작해야 한다. 뉴스는 오래된 글을 되살리지 않는다.
    for (const item of saved) {
        if (item.kind !== "news" && !candidates.some((candidate) => candidate.id === item.id || eventDedupeKey(candidate) === eventDedupeKey(item))) {
            candidates.push(item);
        }
    }
    const unique = new Map();
    for (const item of candidates) {
        const startsAt = item.startsAt ?? extractDateMs(`${item.title} ${item.summary ?? ""}`);
        const next = { ...item, guildId: guild.id, startsAt };
        next.kind = next.kind ?? classifyEvent(next.title, next.summary ?? "");
        next.region ??= eventRegion(next);
        next.bucket = bucketForEvent(next);
        const dedupeKey = eventDedupeKey(next);
        const tracked = savedIds.has(next.id) || savedByDedupe.has(dedupeKey);
        if (!(0, core_2.shouldIncludeEvent)(next, { lookaheadDays: collectorOptions.lookaheadDays, tracked }))
            continue;
        const existing = unique.get(dedupeKey);
        const existingPriority = existing ? EVENT_SOURCE_PRIORITY[existing.source] ?? 10 : 99;
        const nextPriority = EVENT_SOURCE_PRIORITY[next.source] ?? 10;
        if (!existing || nextPriority < existingPriority)
            unique.set(dedupeKey, next);
    }
    const newsLimit = Math.max(1, Number(process.env.NEWS_LIMIT ?? 12) || 12);
    let all = [...unique.values()];
    if (envBool("ENABLE_TRANSLATION", true))
        all = await (0, translation_1.translateEventsToKorean)(all);
    const news = all
        .filter((item) => item.kind === "news")
        .sort((a, b) => (b.startsAt ?? b.publishedAt) - (a.startsAt ?? a.publishedAt))
        .slice(0, newsLimit);
    const nonNews = all.filter((item) => item.kind !== "news");
    const ordered = (0, core_2.interleaveEvents)([...nonNews, ...news]).slice(0, 150);
    let posted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const item of ordered) {
        try {
            const result = await upsertEventItem(guild, item);
            if (result === "created")
                posted++;
            else if (result === "updated")
                updated++;
            else
                unchanged++;
        }
        catch (error) {
            errors.push(`${item.source}/${item.title}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    (0, store_1.setEventStatus)(guild.id, {
        lastSyncAt: Date.now(),
        lastOk: errors.length === 0,
        lastMessage: errors.length ? errors.join(" | ").slice(0, 1000) : "정상",
        fetched: unique.size,
        posted,
        updated,
        unchanged,
        errors,
    });
    releaseUnusedMemory();
    return { fetched: unique.size, posted, updated, unchanged, errors };
}
function parseManualEventLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    const parts = trimmed.split("|").map((p) => p.trim());
    const [datePart, titlePart, urlPart, kindPart] = parts.length >= 3 ? parts : ["", parts[0], parts[1], parts[2]];
    const title = titlePart?.trim();
    const link = urlPart?.trim();
    if (!title || !link)
        return null;
    const startsAt = extractDateMs(datePart || title);
    const kind = kindPart || classifyEvent(title, "");
    const item = {
        id: eventId(link, `manual:${title}`),
        guildId: "",
        title,
        link,
        source: "Manual",
        kind,
        summary: datePart ? `수동 등록 날짜: ${datePart}` : "",
        publishedAt: startsAt ?? Date.now(),
        startsAt,
        manual: true,
    };
    item.bucket = bucketForEvent(item);
    return item;
}
async function handleEventCommand(interaction) {
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    if (interaction.commandName === "event_sync") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        try {
            await ensureEventForums(interaction.guild);
            const result = await syncEvents(interaction.guild);
            const failed = result.errors.length ? `\n수집 실패: ${result.errors.join(" | ").slice(0, 1200)}` : "";
            return interaction.editReply(`✅ 수집 완료: ${result.fetched}개 확인 · 신규 ${result.posted} · 수정/이동 ${result.updated} · 변경 없음 ${result.unchanged}${failed}`);
        }
        catch (e) {
            (0, store_1.setEventStatus)(interaction.guild.id, {
                lastSyncAt: Date.now(),
                lastOk: false,
                lastMessage: e?.message ?? "수집 실패",
                fetched: 0,
                posted: 0,
            });
            return interaction.editReply(`❌ 수집 실패: ${e?.message ?? "알 수 없는 오류"}`);
        }
    }
    if (interaction.commandName === "event_add") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const title = interaction.options.getString("title", true).trim();
        const link = interaction.options.getString("url")?.trim() ?? "";
        if (link && !/^https?:\/\/\S+$/i.test(link)) {
            return interaction.reply({ content: "링크는 http:// 또는 https://로 시작해야 합니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        const deadlineText = interaction.options.getString("registration_deadline")?.trim();
        const startText = interaction.options.getString("start")?.trim();
        const endText = interaction.options.getString("end")?.trim();
        const registrationDeadline = deadlineText ? extractDateMs(deadlineText) : undefined;
        const startsAt = startText ? extractDateMs(startText) : undefined;
        const endsAt = endText ? extractDateMs(endText) : undefined;
        if ((deadlineText && !registrationDeadline) || (startText && !startsAt) || (endText && !endsAt)) {
            return interaction.reply({ content: "날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식으로 입력하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        const kind = interaction.options.getString("kind") ?? classifyEvent(title, "");
        const item = {
            id: eventId(link, `manual:${title}:${startsAt ?? ""}`),
            guildId: interaction.guild.id,
            title,
            link,
            source: "Manual",
            kind,
            summary: interaction.options.getString("description")?.trim() || undefined,
            organizer: interaction.options.getString("organizer")?.trim() || undefined,
            eligibility: interaction.options.getString("eligibility")?.trim() || undefined,
            registration: interaction.options.getString("registration")?.trim() || undefined,
            registrationUrl: link || undefined,
            registrationDeadline,
            teamLimit: interaction.options.getString("team_limit")?.trim() || undefined,
            participationMode: interaction.options.getString("participation_mode") ?? "정보 없음",
            location: interaction.options.getString("location")?.trim() || undefined,
            publishedAt: startsAt ?? Date.now(),
            startsAt,
            endsAt,
            manual: true,
        };
        item.bucket = bucketForEvent(item);
        const result = await upsertEventItem(interaction.guild, item);
        return interaction.reply({ content: result === "created" ? "✅ 보안뉴스/행사를 등록했습니다." : result === "updated" ? "✅ 기존 항목을 갱신했습니다." : "이미 동일한 항목입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (interaction.commandName === "event_import") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const modal = new discord_js_1.ModalBuilder().setCustomId("eventimport").setTitle("행사 공지 가져오기").addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder()
            .setCustomId("list")
            .setLabel("공지 전체 내용 또는 링크")
            .setStyle(discord_js_1.TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000)
            .setPlaceholder("대회/해커톤/컨퍼런스/보안소식 공지를 그대로 붙여 넣으세요.")));
        return interaction.showModal(modal);
    }
    if (interaction.commandName === "event_import_url") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        const url = interaction.options.getString("url", true).trim();
        try {
            const notice = await (0, sources_1.fetchNoticeText)(url);
            const item = (0, core_2.parseEventNotice)(notice, "Direct");
            item.link ||= url;
            item.registrationUrl ||= url;
            item.manual = true;
            const token = genId();
            pendingEventImports.set(token, { event: item, userId: interaction.user.id, guildId: interaction.guild.id });
            const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`eventconfirm:${token}`).setLabel("등록").setStyle(discord_js_1.ButtonStyle.Success), new discord_js_1.ButtonBuilder().setCustomId(`eventcancel:${token}`).setLabel("취소").setStyle(discord_js_1.ButtonStyle.Danger));
            return interaction.editReply({ content: "링크에서 추출한 결과를 확인한 뒤 등록하세요.", embeds: [eventEmbed(item)], components: [row] });
        }
        catch (error) {
            return interaction.editReply(`❌ 링크 분석 실패: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (interaction.commandName === "event_remove") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const items = (0, store_1.getGuildEventItems)(interaction.guild.id).filter((item) => item.manual).slice(0, 25);
        if (items.length === 0)
            return interaction.reply({ content: "삭제할 항목이 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId("eventremove_select")
            .setPlaceholder("삭제할 항목을 고르세요")
            .addOptions(items.map((item) => ({
            label: `${item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정"} ${item.title}`.slice(0, 100),
            value: item.id,
            description: (item.source ?? "").slice(0, 100),
        })));
        return interaction.reply({
            content: "삭제할 보안뉴스/행사를 선택하세요.",
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (interaction.commandName === "event_reset") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        if (interaction.options.getBoolean("confirm") === true) {
            await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
            const result = await resetEventFeature(interaction.guild);
            return interaction.editReply(`🧨 리셋 완료: 채널/카테고리 ${result.channels}개 삭제, 수집 기록 ${result.items}개 초기화` +
                (result.failed ? `\n⚠️ 권한 또는 Discord 오류로 ${result.failed}개 삭제 실패` : ""));
        }
        const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId("eventreset_confirm").setLabel("삭제").setStyle(discord_js_1.ButtonStyle.Danger), new discord_js_1.ButtonBuilder().setCustomId("eventreset_cancel").setLabel("취소").setStyle(discord_js_1.ButtonStyle.Secondary));
        return interaction.reply({
            content: "🧨 보안뉴스/행사 기능이 만든 포럼·일정표 스레드와 수집 기록을 삭제할까요? 되돌릴 수 없습니다.",
            components: [row],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (interaction.commandName === "event_list_manual") {
        const items = (0, store_1.getGuildEventItems)(interaction.guild.id).filter((item) => item.manual).slice(0, 25);
        if (items.length === 0)
            return interaction.reply({ content: "수동 등록 행사가 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const embed = new discord_js_1.EmbedBuilder()
            .setTitle("수동 등록 행사")
            .setColor(0x2b8a3e)
            .setDescription(items
            .map((item) => `• ${item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정"} [${item.title}](${item.link})`)
            .join("\n")
            .slice(0, 4000));
        return interaction.reply({ embeds: [embed], flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (interaction.commandName === "event_status") {
        const status = (0, store_1.getEventStatus)(interaction.guild.id);
        const last = status.lastSyncAt ? `<t:${Math.floor(status.lastSyncAt / 1000)}:R>` : "아직 없음";
        return interaction.reply({
            content: `상태: ${status.lastOk === false ? "일부 오류" : "정상"}\n마지막 수집: ${last}\n확인: ${status.fetched ?? 0}개 · 신규: ${status.posted ?? 0}개 · 수정/이동: ${status.updated ?? 0}개 · 변경 없음: ${status.unchanged ?? 0}개\n메시지: ${status.lastMessage ?? "-"}`,
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    const count = interaction.options.getInteger("count") ?? 10;
    const items = (0, store_1.getGuildEventItems)(interaction.guild.id).slice(0, count);
    if (items.length === 0)
        return interaction.reply({ content: "아직 수집된 보안뉴스/행사가 없습니다. `/event_sync`를 먼저 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle("최근 보안뉴스 · 행사")
        .setColor(0x2b8a3e)
        .setDescription(items.map((item) => `• [${item.title}](${item.link}) · <t:${Math.floor(item.publishedAt / 1000)}:R>`).join("\n").slice(0, 4000));
    return interaction.reply({ embeds: [embed], flags: discord_js_1.MessageFlags.Ephemeral });
}
async function handleProblemCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "생성")
        return interaction.reply(buildSourceSelect(isBotOwner(interaction)));
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    if (sub === "삭제") {
        const problems = (0, store_1.getGuildProblems)(interaction.guild.id);
        if (problems.length === 0)
            return interaction.reply({ content: "삭제할 문제가 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId("del_select")
            .setPlaceholder("삭제할 문제를 선택하세요")
            .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.tier}] ${p.name} · ${p.genre}`.slice(0, 100), value: p.id })));
        return interaction.reply({
            content: "🗑️ 삭제할 문제를 고르세요. (출제자/관리자만 삭제)",
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (sub === "스코어보드")
        return interaction.reply({ embeds: [buildScoreboard(interaction.guild.id)] });
}
async function handleCtfCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    const guildId = interaction.guild.id;
    const parentId = interaction.channel && "parentId" in interaction.channel ? interaction.channel.parentId : null;
    const threadProblem = (0, store_1.getCtfProblemByPost)(interaction.channelId);
    const contest = (threadProblem ? (0, store_1.getCtfContest)(guildId, threadProblem.ctfKey) : undefined)
        ?? contestForChannel(guildId, interaction.channelId, parentId);
    if (["create", "createchallenge", "edit", "deletechallenge", "addpoint", "deletepoint", "warning", "추가", "대회삭제", "시간", "점수추가", "pull", "import"].includes(sub) && !isBotOwner(interaction)) {
        return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "create") {
        const name = interaction.options.getString("name", true).trim();
        const startsAt = (0, core_1.parseKstDateTime)(interaction.options.getString("start", true));
        const endsAt = (0, core_1.parseKstDateTime)(interaction.options.getString("end", true));
        const teamName = interaction.options.getString("team")?.trim() || undefined;
        if (!startsAt || !endsAt || endsAt <= startsAt) {
            return interaction.reply({ content: "일정은 한국 시간 `YYYY-MM-DD HH:mm` 형식으로 입력하고 종료 시각은 시작 이후여야 합니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        const created = await getOrCreateCtf(interaction.guild, name, { startsAt, endsAt, teamName });
        await refreshAllSolveStatus(interaction.guild, created.ctfKey);
        ensureCtfMonitor(interaction.guild);
        return interaction.editReply(`✅ **${name}** 작업 공간을 만들었습니다.\n일정: <t:${Math.floor(startsAt / 1000)}:f> ~ <t:${Math.floor(endsAt / 1000)}:f>\n카테고리: <#${created.categoryId}>`);
    }
    if (sub === "createchallenge") {
        if (!contest)
            return interaction.reply({ content: "이 명령은 `/ctf create`로 만든 CTF 카테고리 안에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const category = (0, core_1.normalizeCtfCategory)(interaction.options.getString("category", true));
        const name = interaction.options.getString("name", true).trim();
        if ((0, store_1.findCtfProblem)(guildId, contest.key, (0, store_1.keyOf)(name)))
            return interaction.reply({ content: "같은 이름의 문제가 이미 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        const channel = await ensureGenreForum(interaction.guild, contest.key, contest.categoryId, contest.roleId, category);
        const problem = await createCtfPost(interaction.guild, channel, contest.name, contest.key, name, category, interaction.user.id);
        return interaction.editReply(`✅ **${category}/${name}** 문제 스레드를 만들었습니다: <#${problem.postId}>`);
    }
    if (sub === "info") {
        if (!contest)
            return interaction.reply({ content: "CTF 작업 공간 안에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const problems = (0, store_1.getGuildCtfProblems)(guildId).filter((problem) => problem.ctfKey === contest.key);
        const solved = problems.filter((problem) => problem.solved).length;
        const embed = new discord_js_1.EmbedBuilder().setTitle(`🚩 ${contest.name}`).setColor(contest.allSolved ? 0x3498db : 0xffffff)
            .addFields({ name: "일정", value: `<t:${Math.floor(contest.startsAt / 1000)}:f> ~ <t:${Math.floor(contest.endsAt / 1000)}:f>` }, { name: "진행", value: `${solved}/${problems.length} solved`, inline: true }, { name: "모니터", value: contest.warningEnabled ? "켜짐" : "꺼짐", inline: true });
        if (contest.sourceUrl)
            embed.setURL(contest.sourceUrl);
        return interaction.reply({ embeds: [embed] });
    }
    if (sub === "edit") {
        if (!contest)
            return interaction.reply({ content: "CTF 작업 공간 안에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const startInput = interaction.options.getString("start");
        const endInput = interaction.options.getString("end");
        const startsAt = startInput ? (0, core_1.parseKstDateTime)(startInput) : contest.startsAt;
        const endsAt = endInput ? (0, core_1.parseKstDateTime)(endInput) : contest.endsAt;
        if (!startsAt || !endsAt || endsAt <= startsAt)
            return interaction.reply({ content: "일정은 KST `YYYY-MM-DD HH:mm` 형식이며 종료가 시작 이후여야 합니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const teamName = interaction.options.getString("team")?.trim() || contest.teamName;
        const updated = (0, store_1.updateCtfContest)(guildId, contest.key, { startsAt, endsAt, teamName });
        (0, store_1.setCtfTime)(guildId, contest.key, startsAt, endsAt);
        if (updated.lobbyChannelId && updated.lobbyMessageId) {
            const lobby = await interaction.guild.channels.fetch(updated.lobbyChannelId).catch(() => null);
            if (lobby?.type === discord_js_1.ChannelType.GuildText) {
                const message = await lobby.messages.fetch(updated.lobbyMessageId).catch(() => null);
                await message?.edit({ content: `다음 대회: **${updated.name}**\n일정: <t:${Math.floor(startsAt / 1000)}:f> ~ <t:${Math.floor(endsAt / 1000)}:f>` }).catch(() => { });
            }
        }
        return interaction.reply({ content: `✅ **${updated.name}** 정보를 수정했습니다.`, flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "history" || sub === "profile") {
        const target = sub === "profile" ? (interaction.options.getUser("user") ?? interaction.user) : interaction.user;
        const records = (0, store_1.getGuildCtfProblems)(guildId).flatMap((problem) => {
            const score = problem.solves[target.id];
            return score == null ? [] : [{ problem, score }];
        });
        const total = records.reduce((sum, row) => sum + row.score, 0);
        const lines = records.slice(0, 20).map(({ problem, score }) => `${score === 1 ? "✅" : "🤝"} **${problem.ctfName}** · ${problem.genre}/${problem.name} (${score})`);
        return interaction.reply({ embeds: [new discord_js_1.EmbedBuilder().setTitle(`${target.username} · CTF profile`).setColor(0x5865f2)
                    .setDescription(lines.length ? lines.join("\n") : "기록이 없습니다.").setFooter({ text: `총 ${total}점 · ${records.length}개 기록` })] });
    }
    if (sub === "defaultsettings") {
        return interaction.reply({ content: "기본값: 한국 시간(KST) · Solve 1점 · Contribute 0.5점 · 카테고리 소문자 · 감시 120초(최소 60초) · 오류 시 최대 15분 백오프", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "warning") {
        if (!contest)
            return interaction.reply({ content: "CTF 작업 공간 안에서 실행하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        const enabled = interaction.options.getBoolean("enabled", true);
        if (enabled && (!contest.publicApiReadable || !contest.sourceUrl || !contest.platform || contest.platform === "generic")) {
            return interaction.reply({ content: "먼저 `/ctf pull`로 CTFd/rCTF 문제를 가져와 플랫폼 주소를 연결하세요. 지원되지 않는 사이트는 수동 등록만 사용합니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        (0, store_1.updateCtfContest)(guildId, contest.key, { warningEnabled: enabled });
        ensureCtfMonitor(interaction.guild);
        return interaction.reply({ content: enabled ? "🔔 저부하 새 문제 감시를 켰습니다. 읽기 전용으로 최소 120초 간격을 사용합니다." : "🔕 새 문제 감시를 껐습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "추가") {
        ctfDrafts.set(interaction.user.id, {});
        return interaction.reply({ ...buildCtfPanel({}), flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "solve") {
        const p = (0, store_1.getCtfProblemByPost)(interaction.channelId);
        if (!p)
            return interaction.reply({ content: "이 명령은 **CTF 문제 게시글(스레드) 안**에서 사용하세요.", flags: discord_js_1.MessageFlags.Ephemeral });
        if (p.solved)
            return interaction.reply({ content: "이미 풀린 문제예요. (처음 푼 사람만 인정)", flags: discord_js_1.MessageFlags.Ephemeral });
        ctfSolveDrafts.set(interaction.user.id, { problemId: p.id, solver: interaction.user.id });
        const solverRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.UserSelectMenuBuilder().setCustomId("solve_solver").setPlaceholder("푼 사람 (기본: 나)").setMinValues(1).setMaxValues(1));
        const helperRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.UserSelectMenuBuilder().setCustomId("solve_helpers").setPlaceholder("도와준 사람 (선택, 0.5솔브)").setMinValues(0).setMaxValues(10));
        const btnRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId("solve_confirm").setLabel("기록").setEmoji("✅").setStyle(discord_js_1.ButtonStyle.Success), new discord_js_1.ButtonBuilder().setCustomId("solve_cancel").setLabel("취소").setStyle(discord_js_1.ButtonStyle.Danger));
        return interaction.reply({
            content: `🏅 **${p.name}** (${p.ctfName}) 풀이 기록 — 푼 사람(1솔브)과 도와준 사람(0.5솔브)을 고르고 **기록**을 누르세요.`,
            components: [solverRow, helperRow, btnRow],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (sub === "수정") {
        const problems = (0, store_1.getGuildCtfProblems)(guildId);
        if (problems.length === 0)
            return interaction.reply({ content: "수정할 CTF 문제가 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId("ctfedit_select")
            .setPlaceholder("수정할 문제를 선택하세요")
            .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.ctfName}] ${p.name} · ${p.genre}`.slice(0, 100), value: p.id })));
        return interaction.reply({
            content: "✏️ 수정할 CTF 문제를 고르세요.",
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (sub === "삭제" || sub === "deletechallenge") {
        let problems = (0, store_1.getGuildCtfProblems)(guildId);
        if (sub === "deletechallenge" && contest)
            problems = problems.filter((problem) => problem.ctfKey === contest.key);
        if (problems.length === 0)
            return interaction.reply({ content: "삭제할 CTF 문제가 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId("ctfdel_select")
            .setPlaceholder("삭제할 문제를 선택하세요")
            .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.ctfName}] ${p.name} · ${p.genre}`.slice(0, 100), value: p.id })));
        return interaction.reply({
            content: "🗑️ 삭제할 CTF 문제를 고르세요. (출제자/관리자만 삭제)",
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (sub === "대회삭제") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const problems = (0, store_1.getGuildCtfProblems)(guildId);
        const seen = new Map();
        for (const existing of (0, store_1.getGuildCtfContests)(guildId))
            seen.set(existing.key, { name: existing.name, count: 0 });
        for (const p of problems) {
            const e = seen.get(p.ctfKey) ?? { name: p.ctfName, count: 0 };
            e.count++;
            seen.set(p.ctfKey, e);
        }
        if (seen.size === 0)
            return interaction.reply({ content: "삭제할 CTF가 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId("ctfwipe_select")
            .setPlaceholder("통째로 삭제할 CTF를 선택하세요")
            .addOptions([...seen.entries()].slice(0, 25).map(([key, v]) => ({ label: `${v.name} (${v.count}문제)`.slice(0, 100), value: key })));
        return interaction.reply({
            content: "🧨 **대회 전체 삭제** — 선택한 CTF의 포럼과 모든 문제가 삭제됩니다. (되돌릴 수 없음)",
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (sub === "시간") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const ctfNameOpt = interaction.options.getString("ctf", true).trim();
        const dur = parseDuration(interaction.options.getString("기간", true));
        if (!dur)
            return interaction.reply({ content: "기간을 인식하지 못했어요. 예: `24h`, `2d`, `1d12h`, `90m`", flags: discord_js_1.MessageFlags.Ephemeral });
        const ctfKey = (0, store_1.keyOf)(ctfNameOpt);
        const start = Date.now();
        const end = start + dur;
        (0, store_1.setCtfTime)(guildId, ctfKey, start, end);
        return interaction.reply({
            content: `⏰ **${ctfNameOpt}** 대회 기간: <t:${Math.floor(start / 1000)}:f> ~ <t:${Math.floor(end / 1000)}:f> (<t:${Math.floor(end / 1000)}:R> 종료)`,
        });
    }
    if (sub === "스코어보드" || sub === "leaderboard") {
        const filter = interaction.options.getString("ctf") ?? undefined;
        return interaction.reply({ embeds: [buildCtfScoreboard(guildId, filter)] });
    }
    if (sub === "점수추가" || sub === "addpoint") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const target = interaction.options.getUser("user", true);
        const amount = sub === "addpoint" ? interaction.options.getString("type", true) : (interaction.options.getString("기여") ?? "1");
        let problems = (0, store_1.getGuildCtfProblems)(guildId);
        if (sub === "addpoint" && contest)
            problems = problems.filter((problem) => problem.ctfKey === contest.key);
        if (problems.length === 0)
            return interaction.reply({ content: "CTF 문제가 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder()
            .setCustomId(`ctfadd:${amount}:${target.id}`)
            .setPlaceholder(`${target.username} 에게 ${amount}솔브 추가할 문제`)
            .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.ctfName}] ${p.name}`.slice(0, 100), value: p.id })));
        return interaction.reply({
            content: `➕ <@${target.id}> 에게 **${amount}솔브** 추가할 문제를 고르세요.`,
            components: [new discord_js_1.ActionRowBuilder().addComponents(menu)],
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    if (sub === "deletepoint") {
        const target = interaction.options.getUser("user", true);
        const problems = (0, store_1.getGuildCtfProblems)(guildId).filter((problem) => problem.solves[target.id] != null && (!contest || problem.ctfKey === contest.key));
        if (!problems.length)
            return interaction.reply({ content: "이 유저의 삭제 가능한 기록이 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const menu = new discord_js_1.StringSelectMenuBuilder().setCustomId(`ctfdeletepoint:${target.id}`).setPlaceholder("삭제할 기록")
            .addOptions(problems.slice(0, 25).map((problem) => ({ label: `[${problem.ctfName}] ${problem.name} (${problem.solves[target.id]})`.slice(0, 100), value: problem.id })));
        return interaction.reply({ content: `<@${target.id}>의 삭제할 기록을 선택하세요.`, components: [new discord_js_1.ActionRowBuilder().addComponents(menu)], flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sub === "pull") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const modal = new discord_js_1.ModalBuilder().setCustomId("ctfpull").setTitle("CTF 문제 읽어오기").addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("url").setLabel("사이트 URL (예: https://ctf.example.com)").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("ctfname").setLabel("이 CTF 이름").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(contest?.name ?? "CTF")), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("duration").setLabel("대회 기간 (선택, 예: 24h)").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false).setMaxLength(20)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("username").setLabel("아이디 (공개 API면 비워두기)").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("password").setLabel("비밀번호 (저장하지 않음)").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false)));
        return interaction.showModal(modal);
    }
    if (sub === "import") {
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const modal = new discord_js_1.ModalBuilder().setCustomId("ctfimport").setTitle("문제 목록 붙여넣기").addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("ctfname").setLabel("이 CTF 이름").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true).setMaxLength(80)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("duration").setLabel("대회 기간 (선택, 예: 24h, 2d)").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false).setMaxLength(20)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder()
            .setCustomId("list")
            .setLabel("문제 목록 (사이트에서 복사해 붙여넣기)")
            .setStyle(discord_js_1.TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000)
            .setPlaceholder("[web][문제1] 설명\n[pwn][문제2] 설명\n... 한 줄에 하나씩")));
        return interaction.showModal(modal);
    }
}
async function handleButton(interaction) {
    const id = interaction.customId;
    if (id.startsWith("eventconfirm:") || id.startsWith("eventcancel:")) {
        const token = id.split(":", 2)[1];
        const pending = pendingEventImports.get(token);
        if (!pending || pending.userId !== interaction.user.id || pending.guildId !== interaction.guildId) {
            return interaction.reply({ content: "만료되었거나 본인의 등록 요청이 아닙니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        pendingEventImports.delete(token);
        if (id.startsWith("eventcancel:")) {
            return interaction.update({ content: "등록을 취소했습니다.", embeds: [], components: [] });
        }
        if (!interaction.guild || !isAdmin(interaction)) {
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        await interaction.update({ content: "행사를 등록하는 중...", embeds: [], components: [] });
        const result = await upsertEventItem(interaction.guild, pending.event);
        return interaction.editReply({ content: result === "created" ? "✅ 등록 완료." : result === "updated" ? "✅ 기존 행사를 갱신했습니다." : "이미 동일한 내용으로 등록되어 있습니다." });
    }
    if (id === "eventreset_cancel") {
        return interaction.update({ content: "❌ 보안뉴스/행사 리셋을 취소했습니다.", components: [] });
    }
    if (id === "eventreset_confirm") {
        if (!interaction.guild)
            return interaction.update({ content: "서버 안에서만 사용할 수 있습니다.", components: [] });
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await interaction.update({ content: "🧨 보안뉴스/행사 포럼과 기록을 삭제하는 중...", components: [] });
        const result = await resetEventFeature(interaction.guild);
        return interaction.editReply({
            content: `🧨 리셋 완료: 채널/카테고리 ${result.channels}개 삭제, 수집 기록 ${result.items}개 초기화` +
                (result.failed ? `\n⚠️ 권한 또는 Discord 오류로 ${result.failed}개 삭제 실패` : ""),
        });
    }
    // 드림핵 생성 패널
    if (id === "c_name")
        return interaction.showModal(textModal("m_name", "문제 이름", "문제 이름을 입력하세요"));
    if (id === "c_flag")
        return interaction.showModal(textModal("m_flag", "정답(플래그)", "플래그를 입력하세요"));
    if (id === "c_genre")
        return interaction.showModal(textModal("m_genre", "장르(카테고리)", "예: web, pwn, crypto"));
    if (id === "c_tier")
        return interaction.showModal(textModal("m_tier", "티어", "예: 브론즈1, 실버3, 골드5"));
    if (id === "c_cancel") {
        drafts.delete(interaction.user.id);
        return interaction.update({ content: "❌ 취소했습니다.", embeds: [], components: [] });
    }
    if (id === "c_submit")
        return finalize(interaction);
    // CTF 추가 패널
    if (id === "cf_ctf")
        return interaction.showModal(textModal("mcf_ctf", "CTF 이름", "예: Codegate 2025"));
    if (id === "cf_genre")
        return interaction.showModal(textModal("mcf_genre", "장르(카테고리)", "예: web, pwn, crypto"));
    if (id === "cf_name")
        return interaction.showModal(textModal("mcf_name", "문제 이름", "문제 이름을 입력하세요"));
    if (id === "cf_cancel") {
        ctfDrafts.delete(interaction.user.id);
        return interaction.update({ content: "❌ 취소했습니다.", embeds: [], components: [] });
    }
    if (id === "cf_submit")
        return finalizeCtf(interaction);
    // 드림핵 플래그 제출
    if (id.startsWith("flag:")) {
        const pid = id.slice("flag:".length);
        if (!(0, store_1.getProblem)(pid))
            return interaction.reply({ content: "이미 삭제된 문제입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        return interaction.showModal(textModal(`fm:${pid}`, "플래그 제출", "정답 플래그를 입력하세요"));
    }
    // CTF '이거 풀래요'
    if (id.startsWith("ctftry:")) {
        const pid = id.slice("ctftry:".length);
        const p = (0, store_1.getCtfProblem)(pid);
        if (!p)
            return interaction.reply({ content: "이미 삭제된 문제입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const thread = await client.channels.fetch(p.postId).catch(() => null);
        if (thread && thread.isThread()) {
            if (thread.archived)
                await thread.setArchived(false).catch(() => { });
            await thread.members.add(interaction.user.id).catch(() => { });
            await thread.send(`🙋 <@${interaction.user.id}> 님이 도전합니다!`).catch(() => { });
        }
        if (interaction.guild) {
            const feed = await ctfCoreChannel(interaction.guild, p.ctfKey, "feed");
            await feed?.send(`🤝 <@${interaction.user.id}> → ${p.genre}/${p.name} 참여`).catch(() => { });
        }
        return interaction.reply({
            content: `참여 완료! <#${p.postId}> 에서 상의하고, 풀면 그 스레드에서 \`/ctf solve\` 를 입력하세요.`,
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    // CTF 대회 참가 (역할 부여)
    if (id.startsWith("ctfjoin:")) {
        const ctfKey = id.slice("ctfjoin:".length);
        if (!interaction.guild)
            return;
        const roleId = (0, store_1.getCtfRole)(interaction.guild.id, ctfKey);
        if (!roleId)
            return interaction.reply({ content: "대회를 찾을 수 없습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const member = interaction.member;
        await member?.roles.add(roleId).catch(() => { });
        const feed = await ctfCoreChannel(interaction.guild, ctfKey, "feed");
        await feed?.send(`🙌 <@${interaction.user.id}> 님이 대회에 참가했습니다.`).catch(() => { });
        return interaction.reply({ content: "🙌 참가 완료! 이제 이 대회의 문제 게시판이 보입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    // /ctf solve 기록/취소
    if (id === "solve_cancel") {
        ctfSolveDrafts.delete(interaction.user.id);
        return interaction.update({ content: "❌ 풀이 기록을 취소했습니다.", components: [] });
    }
    if (id === "solve_confirm")
        return confirmCtfSolve(interaction);
}
async function confirmCtfSolve(interaction) {
    const d = ctfSolveDrafts.get(interaction.user.id);
    if (!d)
        return interaction.update({ content: "세션이 만료됐어요. `/ctf solve` 를 다시 실행하세요.", components: [] });
    const p = (0, store_1.getCtfProblem)(d.problemId);
    if (!p)
        return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
    if (p.solved)
        return interaction.update({ content: "이미 풀린 문제예요. (처음 푼 사람만 인정)", components: [] });
    const solver = d.solver ?? interaction.user.id;
    const helpers = (d.helpers ?? []).filter((h) => h !== solver);
    (0, store_1.recordCtfSolve)(p.id, solver, helpers);
    ctfSolveDrafts.delete(interaction.user.id);
    const helpTxt = helpers.length ? `\n도움: ${helpers.map((h) => `<@${h}>`).join(", ")} (각 0.5솔브)` : "";
    if (interaction.guild) {
        const thread = await client.channels.fetch(p.postId).catch(() => null);
        if (thread?.isThread())
            await thread.setName(`✅｜${p.name}`.slice(0, 100)).catch(() => { });
        const allSolved = await refreshAllSolveStatus(interaction.guild, p.ctfKey);
        const solveCh = await ctfCoreChannel(interaction.guild, p.ctfKey, "solve");
        await solveCh?.send({ embeds: [new discord_js_1.EmbedBuilder()
                    .setTitle(`✅ ${p.name}`)
                    .setColor(allSolved ? 0x3498db : 0xffffff)
                    .setDescription(`solved by <@${solver}>${helpTxt}${allSolved ? "\n\n🔵 ALL SOLVE" : ""}`)
                    .setTimestamp()] }).catch(() => { });
        const feed = await ctfCoreChannel(interaction.guild, p.ctfKey, "feed");
        await feed?.send(`🎉 <@${solver}> → ${p.genre}/${p.name} 풀이${helpers.length ? ` · 기여 ${helpers.map((id) => `<@${id}>`).join(", ")}` : ""}`).catch(() => { });
    }
    return interaction.update({ content: `✅ 기록 완료! <@${solver}> 1솔브${helpers.length ? ` · 도움 ${helpers.length}명` : ""}`, components: [] });
}
async function handleUserSelect(interaction) {
    const d = ctfSolveDrafts.get(interaction.user.id);
    if (!d)
        return interaction.deferUpdate();
    if (interaction.customId === "solve_solver")
        d.solver = interaction.values[0];
    if (interaction.customId === "solve_helpers")
        d.helpers = [...interaction.values];
    ctfSolveDrafts.set(interaction.user.id, d);
    return interaction.deferUpdate();
}
async function handleModal(interaction) {
    const id = interaction.customId;
    if (id === "ctfpull" || id === "ctfimport") {
        if (!interaction.guild || !isBotOwner(interaction)) {
            return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
        }
        return id === "ctfpull" ? handleCtfPullModal(interaction) : handleCtfImportModal(interaction);
    }
    if (id === "eventimport") {
        if (!interaction.guild)
            return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        const raw = interaction.fields.getTextInputValue("list").trim();
        try {
            let notice = raw;
            if (/^https?:\/\/\S+$/i.test(raw))
                notice = await (0, sources_1.fetchNoticeText)(raw);
            const item = (0, core_2.parseEventNotice)(notice, "Direct");
            if (!item.link && /^https?:\/\//i.test(raw))
                item.link = raw;
            item.registrationUrl ||= item.link || undefined;
            item.manual = true;
            const token = genId();
            pendingEventImports.set(token, { event: item, userId: interaction.user.id, guildId: interaction.guild.id });
            const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`eventconfirm:${token}`).setLabel("등록").setStyle(discord_js_1.ButtonStyle.Success), new discord_js_1.ButtonBuilder().setCustomId(`eventcancel:${token}`).setLabel("취소").setStyle(discord_js_1.ButtonStyle.Danger));
            return interaction.editReply({ content: "추출 결과를 확인한 뒤 등록하세요.", embeds: [eventEmbed(item)], components: [row] });
        }
        catch (error) {
            return interaction.editReply(`❌ 공지 추출 실패: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // 드림핵 패널 입력
    if (id === "m_name" || id === "m_flag" || id === "m_tier" || id === "m_genre") {
        const value = interaction.fields.getTextInputValue("value").trim();
        const state = drafts.get(interaction.user.id) ?? {};
        if (id === "m_name")
            state.name = value;
        if (id === "m_flag")
            state.flag = value;
        if (id === "m_tier")
            state.tier = value;
        if (id === "m_genre")
            state.genre = value;
        drafts.set(interaction.user.id, state);
        if (interaction.isFromMessage())
            await interaction.update(buildPanel(state));
        return;
    }
    // CTF 패널 입력
    if (id === "mcf_ctf" || id === "mcf_genre" || id === "mcf_name") {
        const value = interaction.fields.getTextInputValue("value").trim();
        const state = ctfDrafts.get(interaction.user.id) ?? {};
        if (id === "mcf_ctf")
            state.ctfName = value;
        if (id === "mcf_genre")
            state.genre = value;
        if (id === "mcf_name")
            state.name = value;
        ctfDrafts.set(interaction.user.id, state);
        if (interaction.isFromMessage())
            await interaction.update(buildCtfPanel(state));
        return;
    }
    // 드림핵 플래그 제출
    if (id.startsWith("fm:")) {
        const pid = id.slice("fm:".length);
        const problem = (0, store_1.getProblem)(pid);
        if (!problem)
            return interaction.reply({ content: "이미 삭제된 문제입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const value = interaction.fields.getTextInputValue("value").trim();
        if (value !== problem.flag.trim())
            return interaction.reply({ content: "❌ 플래그가 틀렸습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const thread = await client.channels.fetch(problem.vaultThreadId).catch(() => null);
        if (thread && thread.isThread()) {
            if (thread.archived)
                await thread.setArchived(false).catch(() => { });
            await thread.members.add(interaction.user.id).catch(() => { });
        }
        const already = problem.solvers.includes(interaction.user.id);
        (0, store_1.markSolved)(pid, interaction.user.id);
        const solved = (0, store_1.getGuildProblems)(problem.guildId).filter((p) => p.solvers.includes(interaction.user.id)).length;
        return interaction.reply({
            content: already
                ? `✅ 이미 정답 처리됨. <#${problem.vaultThreadId}> 에서 확인하세요.`
                : `✅ 정답! <#${problem.vaultThreadId}> 풀이방 입장 권한 부여 (현재 ${solved}솔브)`,
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    // CTF 수정 저장
    if (id.startsWith("ctfedit:")) {
        const pid = id.slice("ctfedit:".length);
        const p = (0, store_1.getCtfProblem)(pid);
        if (!p)
            return interaction.reply({ content: "이미 삭제된 문제입니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        if (!canManage(interaction, p.authorId))
            return interaction.reply({ content: "⛔ 출제자/관리자만 수정할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const newName = interaction.fields.getTextInputValue("name").trim();
        const newGenre = interaction.fields.getTextInputValue("genre").trim();
        (0, store_1.updateCtfProblem)(pid, { name: newName, nameKey: (0, store_1.keyOf)(newName), genre: newGenre, genreKey: (0, store_1.keyOf)(newGenre) });
        const thread = (await client.channels.fetch(p.postId).catch(() => null));
        if (thread && thread.isThread()) {
            await thread.setName(newName.slice(0, 95)).catch(() => { });
            if (thread.parent && thread.parent.type === discord_js_1.ChannelType.GuildForum) {
                const tagIds = await ensureTags(thread.parent, [newGenre]).catch(() => []);
                if (tagIds.length)
                    await thread.setAppliedTags(tagIds).catch(() => { });
            }
            const starter = await thread.fetchStarterMessage().catch(() => null);
            if (starter)
                await starter.edit({ embeds: [ctfCard(newName, p.ctfName, newGenre, p.authorId)] }).catch(() => { });
        }
        return interaction.reply({ content: `✏️ **${newName}** (${newGenre}) 로 수정했습니다.`, flags: discord_js_1.MessageFlags.Ephemeral });
    }
}
async function handleSelect(interaction) {
    const cid = interaction.customId;
    if (cid === "feat_add" || cid === "feat_del") {
        if (!interaction.guild)
            return interaction.update({ content: "서버 안에서만 사용할 수 있습니다.", components: [] });
        if (!isBotOwner(interaction))
            return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
        const enabled = (0, store_1.getFeatures)(interaction.guild.id);
        const selected = interaction.values.filter((key) => FEATURES[key]);
        const next = cid === "feat_add"
            ? [...new Set([...enabled, ...selected])]
            : enabled.filter((key) => !selected.includes(key));
        (0, store_1.setFeatures)(interaction.guild.id, next);
        await registerGuild(interaction.guild);
        if (cid === "feat_add" && selected.includes("logging"))
            await cacheInvites(interaction.guild);
        if (cid === "feat_add" && selected.includes("events")) {
            await ensureEventForums(interaction.guild);
            ensureEventScheduler(interaction.guild);
        }
        if (cid === "feat_add" && selected.includes("ctf"))
            ensureCtfMonitor(interaction.guild);
        const changed = selected.map((key) => FEATURES[key]?.label ?? key).join(", ");
        const enabledLabels = next.map((key) => FEATURES[key]?.label ?? key);
        return interaction.update({
            content: cid === "feat_add"
                ? `✅ 기능을 켰습니다: ${changed}\n이제 해당 슬래시 명령어가 보입니다.`
                : `✅ 기능을 껐습니다: ${changed}\n해당 슬래시 명령어를 숨겼습니다.`,
            embeds: [
                new discord_js_1.EmbedBuilder()
                    .setTitle("현재 켜진 기능")
                    .setColor(0x5865f2)
                    .setDescription(enabledLabels.length ? enabledLabels.map((label) => `• ${label}`).join("\n") : "켜진 기능이 없습니다."),
            ],
            components: [],
        });
    }
    if (cid === "src_select") {
        if (interaction.values[0] === "dh") {
            drafts.set(interaction.user.id, {});
            return interaction.update(buildPanel({}));
        }
        if (!interaction.guild || !isBotOwner(interaction)) {
            return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
        }
        ctfDrafts.set(interaction.user.id, {});
        return interaction.update(buildCtfPanel({}));
    }
    if (cid === "del_select") {
        const problem = (0, store_1.getProblem)(interaction.values[0]);
        if (!problem)
            return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
        if (!canManage(interaction, problem.authorId))
            return interaction.reply({ content: "⛔ 출제자/관리자만 삭제할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await interaction.update({ content: `🗑️ '${problem.name}' 삭제 중...`, components: [] });
        await deleteChannelSafe(problem.postId);
        await deleteChannelSafe(problem.vaultThreadId);
        (0, store_1.removeProblem)(problem.id);
        return interaction.editReply({ content: `🗑️ **[${problem.tier}] ${problem.name}** 삭제 완료.` });
    }
    if (cid === "eventremove_select") {
        if (!interaction.guildId)
            return interaction.update({ content: "서버 안에서만 사용할 수 있습니다.", components: [] });
        if (!isAdmin(interaction))
            return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const item = (0, store_1.getEventItem)(interaction.guildId, interaction.values[0]);
        if (!item)
            return interaction.update({ content: "이미 삭제된 항목입니다.", components: [] });
        await interaction.update({ content: `🗑️ '${item.title}' 삭제 중...`, components: [] });
        if (item.messageId)
            await deleteChannelSafe(item.messageId);
        (0, store_1.removeEventItem)(interaction.guildId, item.id);
        return interaction.editReply({ content: `🗑️ **${item.title}** 삭제 완료. 일정표는 다음 수집/등록 때 다시 정리됩니다.` });
    }
    if (cid === "ctfdel_select") {
        const p = (0, store_1.getCtfProblem)(interaction.values[0]);
        if (!p)
            return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
        if (!canManage(interaction, p.authorId))
            return interaction.reply({ content: "⛔ 출제자/관리자만 삭제할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        await interaction.update({ content: `🗑️ '${p.name}' 삭제 중...`, components: [] });
        await deleteChannelSafe(p.postId);
        (0, store_1.removeCtfProblem)(p.id);
        if (interaction.guild)
            await refreshAllSolveStatus(interaction.guild, p.ctfKey);
        return interaction.editReply({ content: `🗑️ **[${p.ctfName}] ${p.name}** 삭제 완료.` });
    }
    if (cid === "ctfedit_select") {
        const p = (0, store_1.getCtfProblem)(interaction.values[0]);
        if (!p)
            return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
        if (!canManage(interaction, p.authorId))
            return interaction.reply({ content: "⛔ 출제자/관리자만 수정할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
        const modal = new discord_js_1.ModalBuilder().setCustomId(`ctfedit:${p.id}`).setTitle("CTF 문제 수정").addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("name").setLabel("문제 이름").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(p.name)), new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId("genre").setLabel("장르").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(p.genre)));
        return interaction.showModal(modal);
    }
    if (cid === "ctfwipe_select") {
        if (!interaction.guild || !isBotOwner(interaction)) {
            return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
        }
        const key = interaction.values[0];
        const guildId = interaction.guildId;
        const probs = (0, store_1.getGuildCtfProblems)(guildId).filter((p) => p.ctfKey === key);
        const contest = (0, store_1.getCtfContest)(guildId, key);
        if (!contest && probs.length === 0)
            return interaction.update({ content: "이미 삭제된 CTF입니다.", components: [] });
        const ctfName = contest?.name ?? probs[0].ctfName;
        await interaction.update({ content: `🧨 **${ctfName}** 삭제 중...`, components: [] });
        // 카테고리 자식 채널을 먼저 지워 고아 채널이 남지 않게 한다.
        const catId = contest?.categoryId ?? (0, store_1.getForumFor)(guildId, `ctfcat:${key}`);
        if (catId) {
            await interaction.guild.channels.fetch();
            for (const channel of interaction.guild.channels.cache.values()) {
                if (channel.parentId === catId)
                    await deleteChannelSafe(channel.id);
            }
        }
        if (catId) {
            await deleteChannelSafe(catId);
            (0, store_1.removeForumFor)(guildId, `ctfcat:${key}`);
        }
        for (const prefix of [`ctf:${key}:`, `ctftext:${key}:`]) {
            for (const storeKey of (0, store_1.getForumKeysFor)(guildId, prefix))
                (0, store_1.removeForumFor)(guildId, storeKey);
        }
        // 역할 삭제
        const roleId = (0, store_1.getCtfRole)(guildId, key);
        if (roleId) {
            await interaction.guild?.roles.delete(roleId).catch(() => { });
            (0, store_1.removeCtfRole)(guildId, key);
        }
        (0, store_1.removeCtfTime)(guildId, key);
        (0, store_1.removeCtfContest)(guildId, key);
        for (const p of probs)
            (0, store_1.removeCtfProblem)(p.id);
        return interaction.editReply({ content: `🧨 **${ctfName}** 대회(${probs.length}문제)·채널·역할을 통째로 삭제했습니다.` });
    }
    if (cid.startsWith("ctfadd:")) {
        if (!interaction.guild || !isBotOwner(interaction)) {
            return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
        }
        const [, amountStr, targetId] = cid.split(":");
        const amount = Number(amountStr) || 1;
        const p = (0, store_1.getCtfProblem)(interaction.values[0]);
        if (!p)
            return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
        if (amount === 0.5 && !p.solved)
            return interaction.update({ content: "미해결 문제에는 Contribute만 단독으로 추가할 수 없습니다. Solve 기록을 먼저 추가하세요.", components: [] });
        (0, store_1.setCtfSolve)(p.id, targetId, amount);
        const thread = await client.channels.fetch(p.postId).catch(() => null);
        if (p.solved && thread?.isThread())
            await thread.setName(`✅｜${p.name}`.slice(0, 100)).catch(() => { });
        await refreshAllSolveStatus(interaction.guild, p.ctfKey);
        return interaction.update({
            content: `➕ <@${targetId}> 에게 **${p.name}** (${p.ctfName}) ${amount}솔브를 부여했습니다.`,
            components: [],
        });
    }
    if (cid.startsWith("ctfdeletepoint:")) {
        if (!interaction.guild || !isBotOwner(interaction))
            return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
        const targetId = cid.slice("ctfdeletepoint:".length);
        const problem = (0, store_1.getCtfProblem)(interaction.values[0]);
        if (!problem || !(0, store_1.deleteCtfSolve)(problem.id, targetId))
            return interaction.update({ content: "이미 삭제된 기록입니다.", components: [] });
        if (!problem.solved) {
            const thread = await client.channels.fetch(problem.postId).catch(() => null);
            if (thread?.isThread())
                await thread.setName(problem.name.slice(0, 100)).catch(() => { });
        }
        await refreshAllSolveStatus(interaction.guild, problem.ctfKey);
        return interaction.update({ content: `➖ <@${targetId}>의 **${problem.name}** 기록을 삭제했습니다.`, components: [] });
    }
}
// ── 스코어보드 ────────────────────────────────────────────────────────
function buildScoreboard(guildId) {
    const problems = (0, store_1.getGuildProblems)(guildId);
    const rows = new Map();
    for (const p of problems) {
        for (const uid of p.solvers) {
            const r = rows.get(uid) ?? { names: [], genreCount: new Map() };
            r.names.push(`[${p.tier}] ${p.name} · ${p.genre}`);
            r.genreCount.set((0, store_1.keyOf)(p.genre), (r.genreCount.get((0, store_1.keyOf)(p.genre)) ?? 0) + 1);
            rows.set(uid, r);
        }
    }
    const embed = new discord_js_1.EmbedBuilder().setTitle("🐲 드림핵 스코어보드").setColor(0xfee75c);
    if (rows.size === 0) {
        embed.setDescription("아직 정답자가 없습니다.");
        return embed;
    }
    const sorted = [...rows.entries()].sort((a, b) => b[1].names.length - a[1].names.length);
    const medals = ["🥇", "🥈", "🥉"];
    sorted.slice(0, 15).forEach(([uid, r], i) => {
        const best = [...r.genreCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
        embed.addFields({
            name: `${medals[i] ?? `#${i + 1}`}  ·  ${r.names.length}솔브`,
            value: `<@${uid}>  (주력: ${best})\n${r.names.map((n) => `• ${n}`).join("\n")}`.slice(0, 1024),
        });
    });
    embed.setFooter({ text: `총 ${problems.length}문제 · 정답자 ${rows.size}명` });
    return embed;
}
function buildCtfScoreboard(guildId, ctfFilter) {
    let problems = (0, store_1.getGuildCtfProblems)(guildId);
    if (ctfFilter)
        problems = problems.filter((p) => p.ctfKey === (0, store_1.keyOf)(ctfFilter));
    const embed = new discord_js_1.EmbedBuilder().setTitle("🚩 CTF 스코어보드").setColor(0xeb459e);
    if (problems.length === 0) {
        embed.setDescription(ctfFilter ? `'${ctfFilter}' 에 해당하는 CTF 문제가 없습니다.` : "아직 CTF 문제가 없습니다.");
        return embed;
    }
    // CTF별로 그룹
    const byCtf = new Map();
    for (const p of problems) {
        const g = byCtf.get(p.ctfKey) ?? { ctfName: p.ctfName, probs: [] };
        g.probs.push(p);
        byCtf.set(p.ctfKey, g);
    }
    for (const { ctfName, probs } of byCtf.values()) {
        const pts = new Map();
        for (const p of probs)
            for (const [uid, v] of Object.entries(p.solves ?? {}))
                pts.set(uid, (pts.get(uid) ?? 0) + v);
        const ranking = [...pts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const medals = ["🥇", "🥈", "🥉"];
        const rankBody = ranking.length
            ? ranking.map(([uid, n], i) => `${medals[i] ?? `#${i + 1}`} <@${uid}> — ${n}솔브`).join("\n")
            : "_아직 푼 사람이 없습니다._";
        const time = (0, store_1.getCtfTime)(guildId, probs[0].ctfKey);
        const timeLine = time
            ? `⏰ <t:${Math.floor(time.endsAt / 1000)}:R> ${time.endsAt > Date.now() ? "종료" : "종료됨"}\n`
            : "";
        embed.addFields({ name: `📌 ${ctfName} (총 ${probs.length}문제)`, value: (timeLine + rankBody).slice(0, 1024) });
    }
    return embed;
}
// ── 제출 (드림핵) ─────────────────────────────────────────────────────
async function finalize(interaction) {
    const state = drafts.get(interaction.user.id);
    if (!state?.name || !state.flag || !state.tier || !state.genre) {
        return interaction.reply({ content: "이름·정답·장르·티어를 모두 입력해야 합니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    await interaction.update({ content: "⏳ 문제를 생성하는 중...", embeds: [], components: [] });
    const guild = interaction.guild;
    const genre = (0, core_1.normalizeCtfCategory)(state.genre);
    const { label, base, level } = parseTier(state.tier);
    const title = `[${label}] ${state.name}`;
    const forum = await ensureForum(guild, "dreamhack", "🐲-Dreamhack");
    const vault = await ensureVault(guild);
    const tagIds = await ensureTags(forum, [genre, base]);
    const pid = genId();
    const vaultThread = await vault.threads.create({
        name: title.slice(0, 95),
        type: discord_js_1.ChannelType.PrivateThread,
        invitable: false,
        reason: `문제 생성: ${state.name}`,
    });
    await vaultThread.members.add(interaction.user.id).catch(() => { });
    await vaultThread.send(`🏴 **${title}**  ·  장르 ${genre}\n출제자: <@${interaction.user.id}>\n\n정답자만 입장하는 풀이방입니다.`);
    const card = new discord_js_1.EmbedBuilder()
        .setTitle(`🚩 ${title}`)
        .setColor(0x5865f2)
        .addFields({ name: "장르", value: genre, inline: true }, { name: "티어", value: label, inline: true }, { name: "출제자", value: `<@${interaction.user.id}>`, inline: true })
        .setFooter({ text: "'문제의 답' 버튼으로 플래그를 제출하면 풀이방에 입장합니다." });
    const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`flag:${pid}`).setLabel("문제의 답").setEmoji("🏴").setStyle(discord_js_1.ButtonStyle.Success));
    const post = await forum.threads.create({
        name: title.slice(0, 95),
        message: { embeds: [card], components: [row] },
        appliedTags: tagIds,
        reason: `문제 생성: ${state.name}`,
    });
    const record = {
        id: pid,
        name: state.name,
        flag: state.flag,
        genre,
        tier: label,
        tierBase: base,
        tierLevel: level,
        guildId: guild.id,
        forumId: forum.id,
        postId: post.id,
        vaultThreadId: vaultThread.id,
        authorId: interaction.user.id,
        solvers: [interaction.user.id],
        createdAt: Date.now(),
    };
    (0, store_1.addProblem)(record);
    drafts.delete(interaction.user.id);
    await interaction.editReply({
        content: `✅ **${title}** (${genre}) 생성! 출제자도 1솔브 기록.\n· 게시글: <#${post.id}>\n· 풀이방: <#${vaultThread.id}>`,
    });
}
// ── 제출 (CTF 수동 추가) ──────────────────────────────────────────────
async function finalizeCtf(interaction) {
    const state = ctfDrafts.get(interaction.user.id);
    if (!state?.ctfName || !state.genre || !state.name) {
        return interaction.reply({ content: "CTF 이름·장르·문제 이름을 모두 입력해야 합니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    if (!isBotOwner(interaction))
        return interaction.reply({ content: ownerOnlyMessage(), flags: discord_js_1.MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const ctfName = state.ctfName.trim();
    const ctfKey = (0, store_1.keyOf)(ctfName);
    const genre = state.genre.trim();
    const name = state.name.trim();
    if ((0, store_1.findCtfProblem)(guild.id, ctfKey, (0, store_1.keyOf)(name))) {
        return interaction.reply({ content: `이미 **${ctfName}** 에 같은 이름의 문제가 있습니다.`, flags: discord_js_1.MessageFlags.Ephemeral });
    }
    await interaction.update({ content: "⏳ CTF 문제를 추가하는 중...", embeds: [], components: [] });
    const { categoryId, roleId } = await getOrCreateCtf(guild, ctfName);
    const forum = await ensureGenreForum(guild, ctfKey, categoryId, roleId, genre);
    const rec = await createCtfPost(guild, forum, ctfName, ctfKey, name, genre, interaction.user.id);
    ctfDrafts.delete(interaction.user.id);
    await interaction.editReply({
        content: `✅ **${name}** (${ctfName} · ${genre}) 추가 완료!\n· 게시글: <#${rec.postId}>\n참가하려면 🚩-ctf-로비 에서 **참가할래요** 를 누르세요.`,
    });
}
// ── 붙여넣기 일괄 등록 ────────────────────────────────────────────────
/** 한 줄에서 `[장르]...` 패턴을 찾아 {name, genre} 추출 (없으면 null) */
function parseImportLine(line) {
    const trimmed = line.trim().replace(/\s+/g, " ");
    if (!trimmed)
        return null;
    const m = trimmed.match(/^\[([^\]]+)\]/);
    if (!m)
        return null;
    return { name: trimmed, genre: m[1].trim() };
}
async function handleCtfImportModal(interaction) {
    if (!isAdmin(interaction))
        return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    const ctfName = interaction.fields.getTextInputValue("ctfname").trim();
    const raw = interaction.fields.getTextInputValue("list");
    const seen = new Set();
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
        const parsed = parseImportLine(line);
        if (!parsed)
            continue;
        const key = (0, store_1.keyOf)(parsed.name);
        if (seen.has(key))
            continue;
        seen.add(key);
        items.push(parsed);
    }
    if (items.length === 0) {
        return interaction.reply({
            content: "인식된 문제가 없어요. 각 줄이 `[장르]문제명` 형태인지 확인하세요. (예: `[web][로그인우회] 설명`)",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const dur = parseDuration(interaction.fields.getTextInputValue("duration") ?? "");
    if (dur)
        (0, store_1.setCtfTime)(guild.id, (0, store_1.keyOf)(ctfName), Date.now(), Date.now() + dur);
    const { categoryId, roleId, ctfKey } = await getOrCreateCtf(guild, ctfName);
    const forumCache = new Map();
    let created = 0;
    let skipped = 0;
    for (const { name, genre } of items.slice(0, 50)) {
        if ((0, store_1.findCtfProblem)(guild.id, ctfKey, (0, store_1.keyOf)(name))) {
            skipped++;
            continue;
        }
        let forum = forumCache.get((0, store_1.keyOf)(genre));
        if (!forum) {
            forum = await ensureGenreForum(guild, ctfKey, categoryId, roleId, genre);
            forumCache.set((0, store_1.keyOf)(genre), forum);
        }
        await createCtfPost(guild, forum, ctfName, ctfKey, name, genre, interaction.user.id).catch(() => { });
        created++;
    }
    await interaction.editReply(`✅ **${ctfName}** 일괄 등록: ${created}개 생성, ${skipped}개 중복 (인식 ${items.length}개, 최대 50개).\n참가하려면 🚩-ctf-로비 에서 **참가할래요** 를 누르세요.`);
}
// ── CTFd 로그인 후 문제 목록 가져오기 ─────────────────────────────────
async function ctfdLoginFetch(url, username, password) {
    const jar = new Map();
    const applyCookies = (res) => {
        const sc = res.headers.getSetCookie?.() ?? [];
        for (const c of sc) {
            const pair = c.split(";")[0];
            const idx = pair.indexOf("=");
            if (idx > 0)
                jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
        }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    // 1) 로그인 페이지에서 CSRF nonce + 세션 쿠키 확보
    let res = await fetch(`${url}/login`, { headers: { Cookie: cookie() }, redirect: "manual" });
    applyCookies(res);
    const html = await res.text();
    const nonce = html.match(/['"]csrfNonce['"]\s*:\s*["']([^"']+)["']/)?.[1] ??
        html.match(/csrf_nonce\s*=\s*["']([^"']+)["']/)?.[1] ??
        html.match(/name=["']nonce["']\s+value=["']([^"']+)["']/)?.[1];
    if (!nonce)
        throw new Error("로그인 페이지를 해석하지 못했습니다. CTFd 사이트가 맞는지 URL을 확인하세요.");
    // 2) 로그인 POST
    const body = new URLSearchParams({ name: username, password, nonce, _submit: "Submit" }).toString();
    res = await fetch(`${url}/login`, {
        method: "POST",
        headers: { Cookie: cookie(), "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
    });
    applyCookies(res);
    // 3) 인증된 세션으로 문제 목록 요청
    res = await fetch(`${url}/api/v1/challenges`, {
        headers: { Cookie: cookie(), Accept: "application/json", "CSRF-Token": nonce },
    });
    const json = await res.json().catch(() => null);
    if (!json?.success || !Array.isArray(json?.data)) {
        throw new Error("로그인에 실패했거나 문제 목록을 볼 수 없습니다. 아이디/비밀번호를 확인하세요.");
    }
    return json.data;
}
async function handleCtfPullModal(interaction) {
    if (!isAdmin(interaction))
        return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    if (!interaction.guild)
        return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", flags: discord_js_1.MessageFlags.Ephemeral });
    const url = interaction.fields.getTextInputValue("url").trim().replace(/\/+$/, "");
    const ctfName = interaction.fields.getTextInputValue("ctfname").trim();
    const username = interaction.fields.getTextInputValue("username").trim();
    const password = interaction.fields.getTextInputValue("password");
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    let list;
    let platform = "generic";
    let publicReadable = false;
    try {
        platform = await (0, platforms_1.detectPlatform)(url);
        if (platform !== "generic") {
            list = await (0, platforms_1.fetchPublicChallenges)(platform, url);
            publicReadable = true;
        }
        else if (username && password) {
            const raw = await ctfdLoginFetch(url, username, password);
            platform = "ctfd";
            list = raw.map((item) => ({ externalId: String(item.id), name: String(item.name ?? "").trim(), category: String(item.category ?? "misc").trim() }));
        }
        else if (username) {
            const result = await (0, platforms_1.fetchChallengesWithToken)(url, username);
            platform = result.platform;
            list = result.challenges;
        }
        else {
            throw new Error("공개 문제 API를 찾지 못했습니다. 읽기 토큰 또는 CTFd 계정을 입력하거나 수동 등록을 사용하세요.");
        }
    }
    catch (e) {
        return interaction.editReply(`❌ ${e?.message ?? "가져오기 실패"}\n→ CTF 작업 공간에서 \`/ctf createchallenge category name\`으로 수동 등록할 수 있습니다.`);
    }
    if (list.length === 0)
        return interaction.editReply("⚠️ 연결은 됐지만 현재 공개된 문제가 없습니다.");
    const guild = interaction.guild;
    const dur = parseDuration(interaction.fields.getTextInputValue("duration") ?? "");
    const current = (0, store_1.getCtfContest)(guild.id, (0, store_1.keyOf)(ctfName));
    const startsAt = current?.startsAt ?? Date.now();
    const endsAt = dur ? Date.now() + dur : current?.endsAt;
    const { categoryId, roleId, ctfKey } = await getOrCreateCtf(guild, ctfName, { startsAt, endsAt });
    (0, store_1.updateCtfContest)(guild.id, ctfKey, { platform, sourceUrl: url, publicApiReadable: publicReadable });
    const forumCache = new Map();
    let created = 0;
    let skipped = 0;
    for (const c of list.slice(0, 50)) {
        const name = c.name.trim();
        if (!name)
            continue;
        const genre = (0, core_1.normalizeCtfCategory)(c.category || "misc");
        if ((0, store_1.findCtfProblem)(guild.id, ctfKey, (0, store_1.keyOf)(name))) {
            skipped++;
            continue;
        }
        let forum = forumCache.get((0, store_1.keyOf)(genre));
        if (!forum) {
            forum = await ensureGenreForum(guild, ctfKey, categoryId, roleId, genre);
            forumCache.set((0, store_1.keyOf)(genre), forum);
        }
        const made = await createCtfPost(guild, forum, ctfName, ctfKey, name, genre, interaction.user.id, c.externalId).catch(() => null);
        if (made)
            created++;
    }
    await refreshAllSolveStatus(guild, ctfKey);
    await interaction.editReply(`✅ **${ctfName}** 문제 가져오기 완료: ${created}개 생성, ${skipped}개 중복 (최대 50개).\n${publicReadable ? "공개 읽기 API라 `/ctf warning enabled:true`를 사용할 수 있습니다." : "입력한 인증정보는 저장하지 않았습니다. 자동 감시는 공개 API가 열려 있을 때만 동작합니다."}`);
}
// ── 헬스체크 서버 (PORT 있을 때만) ────────────────────────────────────
if (process.env.PORT) {
    const PORT = Number(process.env.PORT);
    const server = (0, node_http_1.createServer)((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
    });
    server.on("error", (e) => console.error("헬스체크 서버 오류(무시 가능):", e));
    server.listen(PORT, () => console.log(`헬스체크 서버 실행: :${PORT}`));
}
client.login(TOKEN);
