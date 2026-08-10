import "dotenv/config";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, ThreadAutoArchiveDuration, UserSelectMenuBuilder, type ButtonInteraction, type ChatInputCommandInteraction, type Guild, type GuildMember, type TextChannel, type UserSelectMenuInteraction } from "discord.js";
import { findProblem, getChannel, getContest, getContests, getProblem, getProblemByThread, getProblems, keyOf, patchContest, patchProblem, putChannel, putContest, putProblem, removeContest, removeProblem, type CtfContest } from "./store";
import { categoryChannelName, isAllSolved, normalizeCtfCategory, parseKstDateTime } from "./ctf/core";
import { detectPlatform, fetchPublicChallenges, fetchPublicScoreboard } from "./ctf/platforms";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN이 없습니다.");
const ownerId = process.env.BOT_OWNER_ID?.trim();
const guildIds = (process.env.GUILD_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const drafts = new Map<string, { problemId: string; solver: string; helpers: string[] }>();
const deleteDrafts = new Map<string, { guildId: string; ctfKey: string; userId: string; createdAt: number }>();
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const adminSubs = new Set(["create", "createchallenge", "edit", "delete", "deletechallenge", "addpoint", "deletepoint", "pull", "warning", "defaultsettings"]);

const command = new SlashCommandBuilder().setName("ctf").setDescription("DAWN CTF workspace")
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
  .addSubcommand((s) => s.setName("pull").setDescription("Pull public CTFd/rCTF challenges").addStringOption((o) => o.setName("url").setDescription("platform URL").setRequired(true)))
  .addSubcommand((s) => s.setName("warning").setDescription("Toggle monitor").addBooleanOption((o) => o.setName("enabled").setDescription("state").setRequired(true)))
  .addSubcommand((s) => s.setName("defaultsettings").setDescription("Show defaults"));

const core = [["general", "general"], ["bot", "bot-command"], ["announce", "📣｜announce"], ["credential", "🔑｜credential"], ["solve", "📃｜solve"], ["feed", "🤝｜feed"]] as const;
async function channel(guild: Guild, contest: CtfContest, key: string, name: string) { const saved = getChannel(guild.id, `${contest.key}:${key}`); const old = saved ? await guild.channels.fetch(saved).catch(() => null) : null; if (old?.type === ChannelType.GuildText) return old as TextChannel; const made = await guild.channels.create({ name, type: ChannelType.GuildText, parent: contest.categoryId }); putChannel(guild.id, `${contest.key}:${key}`, made.id); return made; }
async function announcementChannel(guild: Guild) {
  const saved = getChannel(guild.id, "announcement");
  const old = saved ? await guild.channels.fetch(saved).catch(() => null) : null;
  if (old?.type === ChannelType.GuildText) return old as TextChannel;
  const existing = guild.channels.cache.find((value) => value.type === ChannelType.GuildText && value.name === "대회-알림");
  if (existing?.type === ChannelType.GuildText) { putChannel(guild.id, "announcement", existing.id); return existing as TextChannel; }
  const made = await guild.channels.create({ name: "대회-알림", type: ChannelType.GuildText, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }, { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
  putChannel(guild.id, "announcement", made.id);
  return made;
}
async function ensureContestAnnouncement(guild: Guild, contest: CtfContest) {
  const announcements = await announcementChannel(guild);
  if (contest.lobbyChannelId === announcements.id && contest.lobbyMessageId) {
    const existing = await announcements.messages.fetch(contest.lobbyMessageId).catch(() => null);
    if (existing) return contest;
  }
  const message = await announcements.send({ content: `다음 대회: **${contest.name}**\n일정: <t:${Math.floor(contest.startsAt / 1000)}:f> ~ <t:${Math.floor(contest.endsAt / 1000)}:f>`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`join:${contest.key}`).setLabel("참가할게").setEmoji("👋").setStyle(ButtonStyle.Primary))] });
  return patchContest(guild.id, contest.key, { lobbyChannelId: announcements.id, lobbyMessageId: message.id })!;
}
async function deleteContestWorkspace(guild: Guild, contest: CtfContest) {
  const failures: string[] = [];
  const announcementId = getChannel(guild.id, "announcement");
  if (contest.lobbyChannelId && contest.lobbyMessageId) {
    const lobby = await guild.channels.fetch(contest.lobbyChannelId).catch(() => null);
    if (lobby?.type === ChannelType.GuildText) await lobby.messages.delete(contest.lobbyMessageId).catch(() => undefined);
    if (lobby?.type === ChannelType.GuildText && lobby.id !== announcementId && lobby.name === `dawn-${contest.key}`.slice(0, 95)) await lobby.delete().catch(() => failures.push("이전 대회 알림 채널"));
  }
  for (const child of guild.channels.cache.filter((value) => value.parentId === contest.categoryId).values()) await child.delete().catch(() => failures.push(`#${child.name}`));
  const category = await guild.channels.fetch(contest.categoryId).catch(() => null);
  if (category) await category.delete().catch(() => failures.push("대회 카테고리"));
  const role = await guild.roles.fetch(contest.roleId).catch(() => null);
  if (role) await role.delete().catch(() => failures.push("참가 역할"));
  if (failures.length) throw new Error(`삭제하지 못한 항목: ${failures.join(", ")}`);
  for (const [userId, draft] of drafts) if (getProblem(draft.problemId)?.ctfKey === contest.key) drafts.delete(userId);
  removeContest(guild.id, contest.key);
}
async function workspace(guild: Guild, name: string, startsAt: number, endsAt: number, teamName?: string) {
  const key = keyOf(name); let role = getContest(guild.id, key)?.roleId ? await guild.roles.fetch(getContest(guild.id, key)!.roleId).catch(() => null) : null;
  role ??= await guild.roles.create({ name: `CTF: ${name}` }); let cat = getContest(guild.id, key)?.categoryId ? await guild.channels.fetch(getContest(guild.id, key)!.categoryId).catch(() => null) : null;
  cat ??= await guild.channels.create({ name: `🚩 ${name}`.slice(0, 95), type: ChannelType.GuildCategory, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: role.id, allow: [PermissionFlagsBits.ViewChannel] }, { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageThreads, PermissionFlagsBits.SendMessages] }] });
  const old = getContest(guild.id, key); let contest: CtfContest = old ? { ...old, name, roleId: role.id, categoryId: cat.id, startsAt, endsAt, teamName: teamName ?? old.teamName, updatedAt: Date.now() } : { guildId: guild.id, key, name, roleId: role.id, categoryId: cat.id, startsAt, endsAt, teamName, allSolved: false, warningEnabled: false, createdAt: Date.now(), updatedAt: Date.now() }; putContest(contest);
  for (const [k, n] of core) await channel(guild, contest, k, n); return ensureContestAnnouncement(guild, contest);
}
function current(i: ChatInputCommandInteraction) { const p = getProblemByThread(i.channelId); if (p) return getContest(i.guildId!, p.ctfKey); const parent = i.channel && "parentId" in i.channel ? i.channel.parentId : null; return getContests(i.guildId!).find((c) => c.categoryId === parent || c.categoryId === i.channelId); }
async function syncCategoryChannels(guild: Guild, c: CtfContest) {
  const byCategory = new Map<string, ReturnType<typeof getProblems>>();
  for (const problem of getProblems(guild.id, c.key)) {
    const problems = byCategory.get(problem.genreKey) ?? [];
    problems.push(problem);
    byCategory.set(problem.genreKey, problems);
  }
  for (const [category, problems] of byCategory) {
    const saved = getChannel(guild.id, `${c.key}:genre:${category}`);
    const genreChannel = saved ? await guild.channels.fetch(saved).catch(() => null) : null;
    const expected = categoryChannelName(category, problems);
    if (genreChannel?.type === ChannelType.GuildText && genreChannel.name !== expected) await genreChannel.setName(expected);
  }
}
async function status(guild: Guild, c: CtfContest) { const ps = getProblems(guild.id, c.key); const all = isAllSolved(ps); patchContest(guild.id, c.key, { allSolved: all }); await syncCategoryChannels(guild, c); const ch = await channel(guild, c, "solve", "📃｜solve"); await ch.send({ embeds: [new EmbedBuilder().setTitle(all ? `🔵 ALL SOLVE · ${c.name}` : `⚪ ${c.name}`).setColor(all ? 0x3498db : 0xffffff).setDescription(`${ps.filter((p) => p.solved).length}/${ps.length} solved`)] }); }
async function challenge(guild: Guild, c: CtfContest, category: string, name: string, externalId?: string) { if (findProblem(guild.id, c.key, name)) return; const genre = normalizeCtfCategory(category); const ch = await channel(guild, c, `genre:${genre}`, `⬜｜${genre}`); const thread = await ch.threads.create({ name, type: ChannelType.PublicThread, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek }); const problem = { id: id(), guildId: guild.id, ctfName: c.name, ctfKey: c.key, name, nameKey: keyOf(name), genre, genreKey: genre, channelId: ch.id, threadId: thread.id, authorId: client.user!.id, scores: {}, solved: false, externalId, createdAt: Date.now() }; putProblem(problem); await thread.send(`**${name}** · ${genre}\n이 스레드에서 \`/ctf solve\`를 사용하세요.`); await status(guild, c); return problem; }

client.once(Events.ClientReady, async () => { for (const g of client.guilds.cache.values()) if (!guildIds.length || guildIds.includes(g.id)) { await g.commands.set([command.toJSON()]); for (const c of getContests(g.id)) { await syncCategoryChannels(g, c); await ensureContestAnnouncement(g, c); } } console.log(`DAWN online: ${client.user!.tag}`); });
client.on(Events.InteractionCreate, async (i) => { try { if (i.isChatInputCommand()) await handle(i); else if (i.isButton()) await button(i); else if (i.isUserSelectMenu()) { const d = drafts.get(i.user.id); if (d) { if (i.customId === "solver") d.solver = i.values[0]; else d.helpers = i.values; } await i.deferUpdate(); } else if (i.isStringSelectMenu()) await select(i.customId, i.values[0], i); } catch (e) { console.error(e); if (i.isRepliable() && !i.replied && !i.deferred) await i.reply({ content: "처리 중 오류가 발생했습니다.", flags: MessageFlags.Ephemeral }); } });
async function handle(i: ChatInputCommandInteraction) { if (!i.guild) return; const sub = i.options.getSubcommand(); if (adminSubs.has(sub) && i.user.id !== (ownerId || i.guild.ownerId)) return void await i.reply({ content: "봇 소유자 전용입니다.", flags: MessageFlags.Ephemeral }); const c = current(i);
  if (sub === "create") { const s = parseKstDateTime(i.options.getString("start", true)), e = parseKstDateTime(i.options.getString("end", true)); if (!s || !e || e <= s) return void await i.reply({ content: "KST YYYY-MM-DD HH:mm 형식을 확인하세요.", flags: MessageFlags.Ephemeral }); await i.deferReply({ flags: MessageFlags.Ephemeral }); const made = await workspace(i.guild, i.options.getString("name", true), s, e, i.options.getString("team") ?? undefined); return void await i.editReply(`생성 완료: <#${made.categoryId}>`); }
  if (sub === "createchallenge") { if (!c) return void await i.reply({ content: "CTF 카테고리 안에서 실행하세요.", flags: MessageFlags.Ephemeral }); await i.deferReply({ flags: MessageFlags.Ephemeral }); const p = await challenge(i.guild, c, i.options.getString("category", true), i.options.getString("name", true)); return void await i.editReply(p ? `<#${p.threadId}> 생성 완료` : "중복 문제입니다."); }
  if (sub === "solve") { const p = getProblemByThread(i.channelId); if (!p || p.solved) return void await i.reply({ content: p ? "이미 풀린 문제입니다." : "문제 스레드에서 실행하세요.", flags: MessageFlags.Ephemeral }); drafts.set(i.user.id, { problemId: p.id, solver: i.user.id, helpers: [] }); return void await i.reply({ content: "푼 사람과 기여자를 선택하세요.", components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId("solver").setPlaceholder("푼 사람").setMinValues(1).setMaxValues(1)), new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId("helpers").setPlaceholder("기여자 (선택)").setMinValues(0).setMaxValues(10)), new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("solve-confirm").setLabel("기록").setStyle(ButtonStyle.Success))], flags: MessageFlags.Ephemeral }); }
  if (sub === "delete") { if (!c) return void await i.reply({ content: "삭제할 CTF 공간 안에서 실행하세요.", flags: MessageFlags.Ephemeral }); const confirmationId = id(); deleteDrafts.set(confirmationId, { guildId: i.guild.id, ctfKey: c.key, userId: i.user.id, createdAt: Date.now() }); return void await i.reply({ content: `**${c.name}**의 채널, 문제, 점수 기록과 참가 역할을 모두 삭제할까요?`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`delete-contest:${confirmationId}`).setLabel("CTF 삭제 확인").setStyle(ButtonStyle.Danger))], flags: MessageFlags.Ephemeral }); }
  if (sub === "info" && c) return void await i.reply({ embeds: [new EmbedBuilder().setTitle(c.name).setDescription(`<t:${Math.floor(c.startsAt / 1000)}:f> ~ <t:${Math.floor(c.endsAt / 1000)}:f>\n${getProblems(i.guild.id, c.key).length} challenges`)] });
  if (sub === "edit" && c) { const start=i.options.getString("start"),end=i.options.getString("end"); const s=start?parseKstDateTime(start):c.startsAt,e=end?parseKstDateTime(end):c.endsAt; if(!s||!e||e<=s)return void await i.reply({content:"KST 일정을 확인하세요.",flags:MessageFlags.Ephemeral}); patchContest(i.guild.id,c.key,{startsAt:s,endsAt:e,teamName:i.options.getString("team")??c.teamName}); return void await i.reply({content:"CTF 정보 수정 완료",flags:MessageFlags.Ephemeral}); }
  if (sub === "profile" || sub === "history") { const u = sub === "profile" ? i.options.getUser("user") ?? i.user : i.user; const rows = getProblems(i.guild.id).filter((p) => p.scores[u.id] != null); return void await i.reply({ embeds: [new EmbedBuilder().setTitle(`${u.username} · ${rows.reduce((n, p) => n + p.scores[u.id], 0)}점`).setDescription(rows.map((p) => `${p.scores[u.id] === 1 ? "✅" : "🤝"} ${p.ctfName}/${p.name}`).join("\n") || "기록 없음")] }); }
  if (sub === "leaderboard") { const totals = new Map<string, number>(); for (const p of getProblems(i.guild.id)) for (const [u, n] of Object.entries(p.scores)) totals.set(u, (totals.get(u) ?? 0) + n); return void await i.reply([...totals.entries()].sort((a,b)=>b[1]-a[1]).map(([u,n],x)=>`${x+1}. <@${u}> · ${n}`).join("\n") || "기록 없음"); }
  if (sub === "pull" && c) { await i.deferReply({ flags: MessageFlags.Ephemeral }); const url = i.options.getString("url", true).replace(/\/+$/, ""); const platform = await detectPlatform(url); if (platform === "generic") return void await i.editReply("지원되는 공개 API가 아닙니다."); const list = await fetchPublicChallenges(platform, url); patchContest(i.guild.id, c.key, { platform, sourceUrl: url, publicApiReadable: true }); let n=0; for (const x of list) if (await challenge(i.guild,c,x.category,x.name,x.externalId)) n++; return void await i.editReply(`${n}개 문제 추가`); }
  if (sub === "warning" && c) { patchContest(i.guild.id,c.key,{warningEnabled:i.options.getBoolean("enabled",true)}); return void await i.reply({content:"변경 완료",flags:MessageFlags.Ephemeral}); }
  if (sub === "defaultsettings") return void await i.reply({content:"KST · Solve 1 · Contribute 0.5 · monitor 120s",flags:MessageFlags.Ephemeral});
  if (["deletechallenge","addpoint","deletepoint"].includes(sub)) { const ps=getProblems(i.guild.id,c?.key); const menu=new StringSelectMenuBuilder().setCustomId(`${sub}:${i.options.getUser("user")?.id ?? ""}:${i.options.getString("type") ?? ""}`).setPlaceholder("문제 선택").addOptions(ps.slice(0,25).map(p=>({label:p.name,value:p.id}))); return void await i.reply({content:"문제를 선택하세요.",components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],flags:MessageFlags.Ephemeral}); }
}
async function button(i: ButtonInteraction) { if (i.customId.startsWith("join:") && i.guild) { const c=getContest(i.guild.id,i.customId.slice(5)); await (i.member as GuildMember).roles.add(c.roleId); return void await i.reply({content:"참가 완료",flags:MessageFlags.Ephemeral}); } if (i.customId.startsWith("delete-contest:") && i.guild) { const confirmationId=i.customId.slice(15),draft=deleteDrafts.get(confirmationId); if(!draft||draft.guildId!==i.guild.id||draft.userId!==i.user.id||Date.now()-draft.createdAt>300_000)return void await i.update({content:"삭제 확인이 만료되었습니다. `/ctf delete`를 다시 실행하세요.",components:[]}); const c=getContest(i.guild.id,draft.ctfKey); deleteDrafts.delete(confirmationId); if(!c)return void await i.update({content:"이미 삭제된 CTF입니다.",components:[]}); await i.update({content:`**${c.name}** 삭제 중...`,components:[]}); try{await deleteContestWorkspace(i.guild,c);await i.editReply({content:`**${c.name}** 삭제 완료`,components:[]});}catch(error){await i.editReply({content:`삭제가 일부 완료되지 않았습니다: ${error instanceof Error?error.message:"알 수 없는 오류"}`,components:[]});}return; } if (i.customId==="solve-confirm" && i.guild) { const d=drafts.get(i.user.id),p=d&&getProblem(d.problemId); if(!d||!p)return; const scores:Record<string,number>={[d.solver]:1}; for(const h of d.helpers)if(h!==d.solver)scores[h]=.5; patchProblem(p.id,{scores,solved:true}); const t=await i.guild.channels.fetch(p.threadId); if(t?.isThread())await t.setName(`✅｜${p.name}`); await status(i.guild,getContest(i.guild.id,p.ctfKey)); drafts.delete(i.user.id); return void await i.update({content:"기록 완료",components:[]}); } }
async function select(custom:string,pid:string,i:any){const [kind,user,amount]=custom.split(":");const p=getProblem(pid);if(!p)return;if(kind==="deletechallenge"){await i.guild.channels.delete(p.threadId);removeProblem(pid);}else if(kind==="addpoint"){patchProblem(pid,{scores:{...p.scores,[user]:Number(amount)},solved:Number(amount)===1||p.solved});}else if(kind==="deletepoint"){const s={...p.scores};delete s[user];patchProblem(pid,{scores:s,solved:Object.values(s).some(n=>n>=1)});}await status(i.guild,getContest(i.guild.id,p.ctfKey));await i.update({content:"완료",components:[]});}
setInterval(async()=>{for(const g of client.guilds.cache.values())for(const c of getContests(g.id))if(c.warningEnabled&&c.publicApiReadable&&c.platform&&c.sourceUrl){try{for(const x of await fetchPublicChallenges(c.platform,c.sourceUrl))await challenge(g,c,x.category,x.name,x.externalId);await fetchPublicScoreboard(c.platform,c.sourceUrl);}catch{}}},Math.max(60,Number(process.env.CTF_MONITOR_INTERVAL_SECONDS)||120)*1000).unref();
client.login(token);
