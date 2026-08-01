require("dotenv").config();
process.env.TZ = process.env.REPORT_TIMEZONE || "Europe/Brussels";

const path = require("path");
const crypto = require("crypto");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ChannelType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const config = require("./config");
const storage = require("./storage");

// Petit serveur HTTP requis par Render Web Service et les services de monitoring.
const express = require("express");
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.get("/", (_req, res) => {
  res.status(200).send("Police Operation Bot is online");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", discord: client?.isReady?.() ?? false });
});

let httpServer;

const TOKEN = process.env.TOKEN;
const CHIEF_ROLE_ID = process.env.CHIEF_ROLE_ID?.trim() || "";
const DATA_FILE = path.join(__dirname, "data", "operations.json");
const REPORTS_FILE = path.join(__dirname, "data", "weekly-reports.json");
const OFFICER_RESETS_FILE = path.join(__dirname, "data", "officer-resets.json");
const operations = new Map();
const pendingProofs = new Map();
let weeklyReports = {};
let officerResets = {};

if (!TOKEN) {
  console.error("❌ TOKEN introuvable dans le fichier .env.");
  process.exit(1);
}


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const guildMemberLoadPromises = new Map();
const guildMembersLoadedAt = new Map();
const MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureGuildMembersLoaded(guild, { force = false } = {}) {
  if (!guild) return false;

  const lastLoadedAt = guildMembersLoadedAt.get(guild.id) || 0;
  const cacheIsFresh = Date.now() - lastLoadedAt < MEMBER_CACHE_TTL_MS;
  if (!force && cacheIsFresh && guild.members.cache.size > 0) return true;

  if (guildMemberLoadPromises.has(guild.id)) {
    return guildMemberLoadPromises.get(guild.id);
  }

  const loadPromise = (async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await guild.members.fetch();
        guildMembersLoadedAt.set(guild.id, Date.now());
        const policeCount = guild.members.cache.filter(
          (member) => !member.user.bot && member.roles.cache.has(config.policeRoleId)
        ).size;
        console.log(
          `✅ Membres chargés pour ${guild.name} : ${guild.members.cache.size} membre(s), ${policeCount} policier(s).`
        );
        return true;
      } catch (error) {
        const retryAfterSeconds = Number(error?.data?.retry_after || error?.retryAfter || 0);
        const waitMs = retryAfterSeconds > 0
          ? Math.ceil(retryAfterSeconds * 1000) + 500
          : attempt * 1500;

        console.warn(
          `⚠️ Chargement des membres impossible sur ${guild.name} (tentative ${attempt}/3) : ${error.message}`
        );

        if (attempt < 3) await sleep(waitMs);
      }
    }

    return false;
  })().finally(() => {
    guildMemberLoadPromises.delete(guild.id);
  });

  guildMemberLoadPromises.set(guild.id, loadPromise);
  return loadPromise;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ Bot connecté : ${readyClient.user.tag}`);
  console.log(`🏢 Serveurs : ${readyClient.guilds.cache.size}`);
  console.log(`💾 Opérations chargées : ${operations.size}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await displayConfigurationStatus(readyClient);

  for (const guild of readyClient.guilds.cache.values()) {
    await ensureGuildMembersLoaded(guild);
  }

  readyClient.user.setActivity("عمليات الشرطة");
  await processPendingOfficerResets(readyClient);
  startOfficerResetScheduler(readyClient);
  startWeeklyReportScheduler(readyClient);
  for (const operation of operations.values()) {
    if (operation.status === "preparation") scheduleAbandonedOperationCleanup(operation.id);
  }
});

client.on(Events.GuildMemberAdd, (member) => {
  guildMembersLoadedAt.set(member.guild.id, Date.now());
});

client.on(Events.GuildMemberRemove, (member) => {
  guildMembersLoadedAt.set(member.guild.id, Date.now());
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const interactionName = interaction.isChatInputCommand()
      ? `/${interaction.commandName}`
      : interaction.customId || interaction.type;

    console.log(
      `[INTERACTION] ${interaction.user.tag} (${interaction.user.id}) -> ${interactionName}`
    );

    // Une demande de correction passe aussi par un formulaire avec consigne obligatoire.
    if (interaction.isModalSubmit() && interaction.customId.startsWith("operation_correction_modal:")) {
      const operationId = interaction.customId.split(":")[1];
      const operation = operations.get(operationId);
      if (!(await verifySupervisor(interaction, operation))) return;

      if (!operation || operation.status !== "pending") {
        await respondEphemeral(interaction, "❌ هذا التقرير غير موجود أو تمت معالجته بالفعل.");
        return;
      }

      const reason = interaction.fields.getTextInputValue("correction_reason").trim();
      if (!reason) {
        await respondEphemeral(interaction, "❌ يجب كتابة التصحيح المطلوب.");
        return;
      }

      operation.status = "correction";
      operation.reviewedBy = interaction.user.id;
      operation.reviewedAt = Date.now();
      operation.correctionReason = reason;
      operation.correctionRequestedAt = Date.now();
      operation.reviewHistory = Array.isArray(operation.reviewHistory) ? operation.reviewHistory : [];
      operation.reviewHistory.push({ action: "correction", userId: interaction.user.id, at: operation.reviewedAt, reason });
      operations.set(operation.id, operation);
      saveOperations();

      const channelId = operation.reviewChannelId || operation.reportChannelId;
      const messageId = operation.reviewMessageId || operation.reportMessageId;
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      const message = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
      if (message) {
        await message.edit({ embeds: [createOperationEmbed(operation)], components: [createOperationButtons(operation.id)] }).catch(() => {});
      }

      await notifyتصحيح(interaction.guild, operation);
      await sendReviewLog(interaction.guild, operation, "correction");
      await respondEphemeral(interaction, `🟠 تم طلب تصحيح للتقرير **${operation.id}**.`);
      return;
    }

    // Le refus passe obligatoirement par un formulaire avec motif.
    if (interaction.isModalSubmit() && interaction.customId.startsWith("operation_reject_modal:")) {
      const operationId = interaction.customId.split(":")[1];
      const operation = operations.get(operationId);
      if (!(await verifySupervisor(interaction, operation))) return;

      if (!operation || operation.status !== "pending") {
        await respondEphemeral(interaction, "❌ هذا التقرير غير موجود أو تمت معالجته بالفعل.");
        return;
      }

      const reason = interaction.fields.getTextInputValue("reject_reason").trim();
      if (!reason) {
        await respondEphemeral(interaction, "❌ سبب الرفض إلزامي.");
        return;
      }

      operation.status = "rejected";
      operation.reviewedBy = interaction.user.id;
      operation.reviewedAt = Date.now();
      operation.rejectionReason = reason;
      operation.reviewHistory = Array.isArray(operation.reviewHistory) ? operation.reviewHistory : [];
      operation.reviewHistory.push({ action: "rejected", userId: interaction.user.id, at: operation.reviewedAt, reason });
      operations.set(operation.id, operation);
      saveOperations();

      const channelId = operation.reviewChannelId || operation.reportChannelId;
      const messageId = operation.reviewMessageId || operation.reportMessageId;
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      const message = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
      if (message) {
        await message.edit({ embeds: [createOperationEmbed(operation)], components: [] }).catch(() => {});
      }

      await notifyLeader(interaction.guild, operation, false);
      await sendReviewLog(interaction.guild, operation, "rejected");
      await respondEphemeral(interaction, `❌ تم رفض التقرير **${operation.id}**. السبب: **${reason}**`);
      return;
    }

    // Discord exige une première réponse en moins de 3 secondes.
    // On confirme immédiatement tous les boutons et menus, puis on modifie le message.
    if (interaction.isMessageComponent() && !interaction.deferred && !interaction.replied && !interaction.customId?.startsWith("operation_reject:") && !interaction.customId?.startsWith("operation_correction:")) {
      await interaction.deferUpdate();
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "operation") {
        await handleOperationCommand(interaction);
        return;
      }

      if (interaction.commandName === "prime") {
        await handlePrimeCommand(interaction);
        return;
      }

      if (interaction.commandName === "classement") {
        await handleRankingCommand(interaction);
        return;
      }

      if (interaction.commandName === "rapport-semaine") {
        await handleWeeklyReportCommand(interaction);
        return;
      }

      if (interaction.commandName === "controleurs") {
        await handleControllerStatsCommand(interaction);
        return;
      }

      if (interaction.commandName === "revision") {
        await handleRevisionCenterCommand(interaction);
        return;
      }
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "operation_type_select"
    ) {
      const operationKey = interaction.values[0];
      const operationType = config.operationTypes[operationKey];

      if (!operationType) {
        await respondEphemeral(interaction, "❌ هذه العملية غير موجودة.");
        return;
      }

      const operation = {
        id: createOperationId(),
        guildId: interaction.guildId,
        leaderId: interaction.user.id,
        operationKey,
        operationName: operationType.name,
        operationEmoji: operationType.emoji,
        categoryKey: operationType.categoryKey,
        memberIds: [],
        proofUrl: null,
        proofName: null,
        status: "preparation",
        createdAt: Date.now(),
      };

      // Le menu /operation est éphémère. Le vrai rapport doit être envoyé
      // comme message normal dans le salon, sinon il est impossible de le
      // retrouver depuis l’événement MessageCreate quand une preuve arrive.
      const reportMessage = await interaction.channel.send({
        embeds: [createOperationEmbed(operation)],
        components: [createOperationButtons(operation.id)],
      });

      operation.reportChannelId = reportMessage.channelId;
      operation.reportMessageId = reportMessage.id;
      operations.set(operation.id, operation);
      saveOperations();

      await interaction.editReply({
        content: `✅ تم إنشاء التقرير **${operation.id}** في هذه القناة.`,
        embeds: [],
        components: [],
      });
      scheduleEphemeralDelete(interaction);
      scheduleAbandonedOperationCleanup(operation.id);
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_add_members:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;
      if (!(await verifyPreparation(interaction, operation))) return;

      const loaded = await ensureGuildMembersLoaded(interaction.guild);
      if (!loaded) {
        await respondEphemeral(
          interaction,
          "❌ تعذر تحميل قائمة أفراد الشرطة كاملة حالياً. حاول مرة أخرى بعد بضع ثوانٍ."
        );
        return;
      }

      const policeMembers = getEligiblePoliceMembers(interaction.guild, operation);
      if (policeMembers.size === 0) {
        await respondEphemeral(
          interaction,
          "❌ لا يوجد أي عضو آخر يحمل رتبة Police حالياً. تأكد من أن الأعضاء لديهم هذه الرتبة."
        );
        return;
      }

      await interaction.editReply(createMemberSelectionView(operation, interaction.guild, 0));
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_members_page:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;
      if (!(await verifyPreparation(interaction, operation))) return;

      const requestedPage = Number(interaction.customId.split(":")[2] || 0);
      await interaction.editReply(
        createMemberSelectionView(operation, interaction.guild, requestedPage)
      );
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_members_done:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;
      if (!(await verifyPreparation(interaction, operation))) return;

      await interaction.editReply({
        embeds: [createOperationEmbed(operation)],
        components: [createOperationButtons(operation.id)],
      });
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("operation_members_select:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;
      if (!(await verifyPreparation(interaction, operation))) return;

      const parts = interaction.customId.split(":");
      const page = Number(parts[2] || 0);
      const chunk = Number(parts[3] || 0);
      const policeMembers = [...getEligiblePoliceMembers(interaction.guild, operation).values()];
      const pageMembers = policeMembers.slice(page * 100, page * 100 + 100);
      const chunkMembers = pageMembers.slice(chunk * 25, chunk * 25 + 25);
      const chunkMemberIds = new Set(chunkMembers.map((member) => member.id));

      const selectedIds = new Set(
        interaction.values.filter(
          (id) => id !== operation.leaderId && chunkMemberIds.has(id)
        )
      );

      const preservedIds = (operation.memberIds || []).filter(
        (id) => !chunkMemberIds.has(id)
      );
      operation.memberIds = [...new Set([...preservedIds, ...selectedIds])];
      operations.set(operation.id, operation);
      saveOperations();

      await interaction.editReply(
        createMemberSelectionView(operation, interaction.guild, page)
      );
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_members_cancel:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;

      await interaction.editReply({
        embeds: [createOperationEmbed(operation)],
        components: [createOperationButtons(operation.id)],
      });
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_add_proof:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;
      if (!(await verifyPreparation(interaction, operation))) return;

      // Une seule demande de preuve active pour ce policier dans ce salon.
      const proofKey = `${interaction.guildId}:${interaction.channelId}:${interaction.user.id}`;
      pendingProofs.delete(proofKey);

      pendingProofs.set(proofKey, {
        operationId: operation.id,
        proofChannelId: interaction.channelId,
        reportMessageId: interaction.message.id,
        expiresAt: Date.now() + 2 * 60 * 1000,
        controlInteraction: interaction,
      });

      const cancelButton = new ButtonBuilder()
        .setCustomId(`operation_proof_cancel:${operation.id}`)
        .setLabel("إلغاء")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger);

      await interaction.editReply({
        embeds: [
          createOperationEmbed(operation).setDescription(
            [
              "📷 **إضافة دليل**",
              "",
              `<@${operation.leaderId}>, أرسل الآن **صورة في نفس القناة**.`,
              "سيضيف البوت الصورة إلى التقرير ثم يحذف رسالتك تلقائياً.",
              "",
              "الصيغ المقبولة: **JPG وJPEG وPNG وWEBP**.",
              "⏳ المهلة: **دقيقتان**.",
            ].join("\n")
          ),
        ],
        components: [new ActionRowBuilder().addComponents(cancelButton)],
        allowedMentions: { users: [operation.leaderId] },
      });

      setTimeout(async () => {
        const currentPending = pendingProofs.get(proofKey);
        if (
          !currentPending ||
          currentPending.operationId !== operation.id ||
          currentPending.reportMessageId !== interaction.message.id
        ) {
          return;
        }

        pendingProofs.delete(proofKey);
        await interaction.message.edit({
          embeds: [createOperationEmbed(operation)],
          components: [createOperationButtons(operation.id)],
        }).catch(() => {});
      }, 2 * 60 * 1000);
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_proof_cancel:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;

      const proofKey = `${interaction.guildId}:${interaction.channelId}:${interaction.user.id}`;
      pendingProofs.delete(proofKey);

      await interaction.editReply({
        embeds: [createOperationEmbed(operation)],
        components: [createOperationButtons(operation.id)],
      });
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_submit:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifyLeader(interaction, operation))) return;
      if (!(await verifyPreparation(interaction, operation))) return;

      if (operation.memberIds.length === 0) {
        await respondEphemeral(interaction, "❌ يجب إضافة شرطي واحد على الأقل قبل إرسال التقرير.");
        return;
      }

      if (!operation.proofUrl) {
        await respondEphemeral(interaction, "❌ يجب إضافة دليل قبل إرسال التقرير.");
        return;
      }

      const duplicateSignals = findRecentDuplicateSignals(operation);
      operation.duplicateProofOf = duplicateSignals.proof?.id || null;
      operation.duplicateMembersOf = duplicateSignals.members?.operation?.id || null;
      operation.duplicateMembersPercent = duplicateSignals.members?.percent || null;
      // Compatibilité avec les anciennes versions du bot.
      operation.duplicateOf = operation.duplicateProofOf || operation.duplicateMembersOf || null;
      const farmSignals = findAntiFarmSignals(operation);
      operation.antiFarmCount = farmSignals.count;
      operation.antiFarmOperationIds = farmSignals.operationIds;
      const suspicion = calculateSuspicion(operation);
      operation.suspicionScore = suspicion.score;
      operation.suspicionLevel = suspicion.level;
      operation.suspicionReasons = suspicion.reasons;
      operation.status = "pending";
      operation.submittedAt = Date.now();
      operation.resubmittedAt = operation.correctionReason ? Date.now() : operation.resubmittedAt || null;

      // Le rapport actuel devient aussi le rapport de validation : aucun second embed.
      operation.reviewChannelId = interaction.channelId;
      operation.reviewMessageId = interaction.message.id;
      operations.set(operation.id, operation);
      saveOperations();

      await interaction.editReply({
        content: null,
        embeds: [createOperationEmbed(operation)],
        components: [createReviewButtons(operation.id)],
      });

      // Petite notification temporaire pour prévenir les rôles autorisés,
      // sans laisser un deuxième rapport dans le salon.
      const reviewRoleIds = isConfiguredId(config.supervisorRoleId)
        ? [config.supervisorRoleId]
        : [];

      if (reviewRoleIds.length > 0) {
        const roleMentions = reviewRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");
        const duplicateWarning = buildDuplicateWarningText(operation);
        const notification = await interaction.channel.send({
          content: duplicateWarning
            ? `${roleMentions} — ⚠️ **تنبيه تكرار محتمل** في العملية **${operation.id}**\n${duplicateWarning}`
            : `${roleMentions} — العملية **${operation.id}** بانتظار المراجعة.`,
          allowedMentions: { roles: reviewRoleIds },
        }).catch(() => null);

        if (notification) {
          setTimeout(() => {
            notification.delete().catch(() => {});
          }, 10 * 1000);
        }
      }

      const submittedNotice = await interaction.followUp({
        content: "✅ تم إرسال التقرير وإبلاغ مسؤولي المراجعة.",
        flags: MessageFlags.Ephemeral,
        withResponse: true,
      });

      // Les follow-ups éphémères ne sont pas la réponse originale :
      // deleteReply() ne peut donc pas les supprimer. On supprime précisément
      // ce message via le webhook Discord après 30 secondes.
      const submittedMessage = submittedNotice?.resource?.message ?? submittedNotice;
      if (submittedMessage?.id) {
        setTimeout(() => {
          interaction.webhook.deleteMessage(submittedMessage.id).catch(() => {});
        }, TEMP_MESSAGE_TTL_MS);
      }
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_check:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifySupervisor(interaction, operation))) return;

      if (!operation || operation.status !== "pending") {
        await respondEphemeral(interaction, "❌ هذا التقرير غير موجود أو تمت معالجته بالفعل.");
        return;
      }

      const audit = buildOperationAudit(operation);
      await respondEphemeral(interaction, audit);
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_approve:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifySupervisor(interaction, operation))) return;

      if (!operation || operation.status !== "pending") {
        await respondEphemeral(interaction, "❌ هذا التقرير غير موجود أو تمت معالجته بالفعل.");
        return;
      }

      operation.status = "approved";
      operation.reviewedBy = interaction.user.id;
      operation.reviewedAt = Date.now();
      operation.reviewHistory = Array.isArray(operation.reviewHistory) ? operation.reviewHistory : [];
      operation.reviewHistory.push({ action: "approved", userId: interaction.user.id, at: operation.reviewedAt });
      operations.set(operation.id, operation);
      saveOperations();

      await interaction.editReply({
        content: null,
        embeds: [createOperationEmbed(operation)],
        components: [],
      });
      await notifyLeader(interaction.guild, operation, true);
      await sendReviewLog(interaction.guild, operation, "approved");
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_reject:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifySupervisor(interaction, operation))) return;

      if (!operation || operation.status !== "pending") {
        await respondEphemeral(interaction, "❌ هذا التقرير غير موجود أو تمت معالجته بالفعل.");
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`operation_reject_modal:${operation.id}`)
        .setTitle(`رفض ${operation.id}`);

      const reasonInput = new TextInputBuilder()
        .setCustomId("reject_reason")
        .setLabel("سبب الرفض")
        .setPlaceholder("اكتب سبب الرفض بشكل إلزامي...")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(800);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("operation_correction:")
    ) {
      const operation = getOperationFromInteraction(interaction);
      if (!(await verifySupervisor(interaction, operation))) return;

      if (!operation || operation.status !== "pending") {
        await respondEphemeral(interaction, "❌ هذا التقرير غير موجود أو تمت معالجته بالفعل.");
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`operation_correction_modal:${operation.id}`)
        .setTitle(`تصحيح ${operation.id}`);

      const reasonInput = new TextInputBuilder()
        .setCustomId("correction_reason")
        .setLabel("التصحيح المطلوب")
        .setPlaceholder("مثال: أضف الدليل الكامل أو صحح قائمة المشاركين...")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(800);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
      return;
    }

  } catch (error) {
    console.error("❌ Erreur pendant une interaction :", error);
    const response = {
      content: "❌ حدث خطأ أثناء استخدام البوت.",
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    if (!isConfiguredId(config.policeRoleId)) return;

    const hadPoliceRole = oldMember.roles.cache.has(config.policeRoleId);
    const hasPoliceRole = newMember.roles.cache.has(config.policeRoleId);

    if (hadPoliceRole && !hasPoliceRole) {
      scheduleOfficerReset(newMember.guild.id, newMember.id);
      console.log(`⏳ Remise à zéro programmée dans 24 h pour ${newMember.user.tag}.`);
    }

    if (!hadPoliceRole && hasPoliceRole) {
      if (cancelOfficerReset(newMember.guild.id, newMember.id)) {
        console.log(`✅ Remise à zéro annulée pour ${newMember.user.tag}.`);
      }
    }
  } catch (error) {
    console.error("❌ Erreur pendant la surveillance du rôle Police :", error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    const proofKey = `${message.guildId}:${message.channelId}:${message.author.id}`;
    const pendingProof = pendingProofs.get(proofKey);
    if (!pendingProof) return;

    const operation = operations.get(pendingProof.operationId);
    if (!operation) {
      pendingProofs.delete(proofKey);
      await message.delete().catch(() => {});
      return;
    }

    if (message.author.id !== operation.leaderId) return;

    if (Date.now() > pendingProof.expiresAt) {
      pendingProofs.delete(proofKey);
      const reportMessage = await message.channel.messages
        .fetch(pendingProof.reportMessageId)
        .catch(() => null);
      if (reportMessage) {
        await reportMessage.edit({
          embeds: [createOperationEmbed(operation)],
          components: [createOperationButtons(operation.id)],
        }).catch(() => {});
      }
      return;
    }

    const attachment = message.attachments.first();
    if (!attachment) {
      await message.reply({
        content: "❌ يجب إرسال صورة كمرفق.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    if (!isValidImage(attachment)) {
      await message.reply({
        content: "❌ صيغة غير صحيحة. أرسل صورة JPG أو JPEG أو PNG أو WEBP.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      await message.reply({
        content: "❌ تعذر تحميل هذه الصورة. حاول باستخدام دليل آخر.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    // بصمة ثابتة للصورة: تكشف نفس الدليل حتى لو أعيد رفعه باسم أو رابط مختلف.
    operation.proofHash = crypto.createHash("sha256").update(imageBuffer).digest("hex");
    const extension = path.extname(attachment.name || "") || ".png";
    const proofFileName = `preuve-${operation.id}${extension}`
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 100);
    const proofFile = new AttachmentBuilder(imageBuffer, { name: proofFileName });

    const reportMessage = await message.channel.messages
      .fetch(pendingProof.reportMessageId)
      .catch(() => null);

    if (!reportMessage) {
      pendingProofs.delete(proofKey);
      await message.reply({
        content: "❌ تعذر العثور على تقرير العملية.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    operation.proofUrl = `attachment://${proofFileName}`;
    operation.proofName = proofFileName;
    operation.proofAddedAt = Date.now();

    const editedReport = await reportMessage.edit({
      embeds: [createOperationEmbed(operation)],
      components: [createOperationButtons(operation.id)],
      attachments: [],
      files: [proofFile],
    });

    const storedAttachment = editedReport.attachments.first();
    if (storedAttachment) {
      operation.proofUrl = storedAttachment.url;
      operation.proofName = storedAttachment.name;

      await editedReport.edit({
        embeds: [createOperationEmbed(operation)],
        components: [createOperationButtons(operation.id)],
      });
    }

    operations.set(operation.id, operation);
    pendingProofs.delete(proofKey);
    saveOperations();

    // Supprime la capture envoyée par le policier : elle reste uniquement dans l’embed du bot.
    await message.delete().catch(() => {});
  } catch (error) {
    console.error("❌ Erreur pendant la réception d’une preuve :", error);
  }
});

async function handleOperationCommand(interaction) {
  if (!(await hasPoliceRole(interaction.guild, interaction.user.id))) {
    await interaction.reply({
      content: "❌ يجب أن تكون لديك رتبة Police لإنشاء عملية.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("🚨 إنشاء عملية")
    .setDescription(
      [
        "اختر مباشرة **اسم العملية**.",
        "",
        "سيحدد البوت الفئة تلقائياً ويحسب المكافآت.",
        "",
        `🟢 **صغرى** — القائد: **${formatMoney(config.rewards.minor.leaderBonus)} €** | العضو: **${formatMoney(config.rewards.minor.memberBonus)} €**`,
        `🟡 **متوسطة** — القائد: **${formatMoney(config.rewards.medium.leaderBonus)} €** | العضو: **${formatMoney(config.rewards.medium.memberBonus)} €**`,
        `🔴 **كبرى** — القائد: **${formatMoney(config.rewards.major.leaderBonus)} €** | العضو: **${formatMoney(config.rewards.major.memberBonus)} €**`,
      ].join("\n")
    )
    .setFooter({ text: "ستصبح تلقائياً قائد العملية." });

  await interaction.reply({ embeds: [embed], components: [createOperationTypeSelect()], flags: MessageFlags.Ephemeral });
}

async function handlePrimeCommand(interaction) {
  const requestedUser = interaction.options.getUser("policier") || interaction.user;

  if (requestedUser.id !== interaction.user.id && !(await isSupervisor(interaction))) {
    await interaction.reply({
      content: "❌ يمكن للمشرفين فقط الاطلاع على مكافأة شرطي آخر.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!(await hasPoliceRole(interaction.guild, requestedUser.id))) {
    await interaction.reply({
      content: "❌ هذا العضو لا يحمل رتبة Police، لذلك لن يتم عرض سجله.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const stats = calculateWeeklyStatsForUser(requestedUser.id, interaction.guildId);
  const { start, end } = getCurrentWeekRange();

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`💰 المكافأة الأسبوعية — ${requestedUser.username}`)
    .setThumbnail(requestedUser.displayAvatarURL())
    .setDescription(`Du <t:${Math.floor(start.getTime() / 1000)}:d> au <t:${Math.floor(end.getTime() / 1000)}:d>`)
    .addFields(
      {
        name: "👑 كقائد عملية",
        value: formatStatsBlock(stats.leader, "leaderBonus"),
        inline: false,
      },
      {
        name: "👥 كمشارك",
        value: formatStatsBlock(stats.member, "memberBonus"),
        inline: false,
      },
      {
        name: "📊 الملخص",
        value: [
          `العمليات كقائد: **${stats.leader.totalCount}**`,
          `العمليات كمشارك: **${stats.member.totalCount}**`,
          `إجمالي العمليات: **${stats.leader.totalCount + stats.member.totalCount}**`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "💵 إجمالي المكافأة",
        value: `**${formatMoney(stats.totalBonus)} €**`,
        inline: false,
      }
    )
    .setFooter({ text: footerText })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleRankingCommand(interaction) {
  const activePoliceIds = await getActivePoliceUserIds(interaction.guild);
  const ranking = calculateWeeklyRanking(interaction.guildId, getCurrentWeekRange(), activePoliceIds).slice(0, 10);
  const { start, end } = getCurrentWeekRange();

  const lines = ranking.length
    ? ranking.map((entry, index) => {
        const medals = ["🥇", "🥈", "🥉"];
        const rank = medals[index] || `**${index + 1}.**`;
        return `${rank} <@${entry.userId}> — **${formatMoney(entry.totalBonus)} €**\n└ ${entry.operationCount} عملية، منها ${entry.leaderCount} كقائد`;
      })
    : ["لا توجد عمليات معتمدة هذا الأسبوع."];

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🏆 الترتيب الأسبوعي لأفراد الشرطة")
    .setDescription(
      `Du <t:${Math.floor(start.getTime() / 1000)}:d> au <t:${Math.floor(end.getTime() / 1000)}:d>\n\n${lines.join("\n\n")}`
    )
    .setFooter({ text: "الترتيب يعتمد على مكافآت العمليات المعتمدة." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleWeeklyReportCommand(interaction) {
  if (!(await canReviewOperations(interaction))) {
    console.log("Résultat : REFUSÉ — rôle Operations Controller ou Chief of Police absent.");
    await interaction.reply({
      content:
        "❌ فقط **Operations Controller** أو **Chief of Police** يمكنهم نشر التقرير الأسبوعي.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const period = interaction.options.getString("periode") || "current";
  const range = period === "previous" ? getPreviousWeekRange() : getCurrentWeekRange();
  const embeds = await createWeeklyReportEmbeds(interaction.guild, range);

  const targetChannel = await getStatsChannel(interaction.guild);
  if (!targetChannel) {
    await interaction.reply({
      content: "❌ تعذر العثور على قناة الإحصائيات. تحقق من STATS_CHANNEL_ID في ملف .env.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const messageIds = [];
  for (const embed of embeds) {
    const message = await targetChannel.send({ embeds: [embed] });
    messageIds.push(message.id);
  }

  const logsChannel = await getLogsChannel(interaction.guild);
  if (logsChannel && logsChannel.id !== targetChannel.id) {
    await sendReportCopyToLogs(logsChannel, embeds, "النشر اليدوي للتقرير الأسبوعي");
  }

  archiveWeeklyReport(interaction.guildId, range, messageIds, interaction.user.id, false);
  await interaction.editReply(
    logsChannel && logsChannel.id !== targetChannel.id
      ? `✅ Rapport publié dans <#${targetChannel.id}> et copié dans <#${logsChannel.id}>.`
      : `✅ Rapport publié dans <#${targetChannel.id}>.`
  );
}

function calculateWeeklyStatsForUser(userId, guildId, range = getCurrentWeekRange()) {
  const stats = createEmptyUserStats();
  const { start, end } = range;

  for (const operation of operations.values()) {
    if (operation.status !== "approved") continue;
    if (guildId && operation.guildId && operation.guildId !== guildId) continue;

    const validationTime = operation.reviewedAt || operation.submittedAt || operation.createdAt;
    if (validationTime < start.getTime() || validationTime > end.getTime()) continue;
    if (validationTime < getOfficerResetAt(guildId, userId)) continue;

    const category = config.rewards[operation.categoryKey];
    if (!category) continue;

    if (operation.leaderId === userId) {
      stats.leader[operation.categoryKey] += 1;
      stats.leader.totalCount += 1;
      stats.totalBonus += category.leaderBonus;
    }

    if (operation.memberIds?.includes(userId)) {
      stats.member[operation.categoryKey] += 1;
      stats.member.totalCount += 1;
      stats.totalBonus += category.memberBonus;
    }
  }

  return stats;
}

function calculateWeeklyRanking(guildId, range = getCurrentWeekRange(), activePoliceIds = null) {
  const userIds = new Set();
  const { start, end } = range;

  for (const operation of operations.values()) {
    if (operation.status !== "approved") continue;
    if (guildId && operation.guildId && operation.guildId !== guildId) continue;
    const validationTime = operation.reviewedAt || operation.submittedAt || operation.createdAt;
    if (validationTime < start.getTime() || validationTime > end.getTime()) continue;

    userIds.add(operation.leaderId);
    for (const memberId of operation.memberIds || []) userIds.add(memberId);
  }

  return [...userIds]
    .filter((userId) => !activePoliceIds || activePoliceIds.has(userId))
    .map((userId) => {
      const stats = calculateWeeklyStatsForUser(userId, guildId, range);
      return {
        userId,
        totalBonus: stats.totalBonus,
        leaderCount: stats.leader.totalCount,
        operationCount: stats.leader.totalCount + stats.member.totalCount,
      };
    })
    .sort((a, b) => b.totalBonus - a.totalBonus || b.operationCount - a.operationCount);
}

function createEmptyUserStats() {
  return {
    leader: { minor: 0, medium: 0, major: 0, totalCount: 0 },
    member: { minor: 0, medium: 0, major: 0, totalCount: 0 },
    totalBonus: 0,
  };
}

function formatStatsBlock(section, rewardKey) {
  const rows = ["minor", "medium", "major"].map((key) => {
    const category = config.rewards[key];
    const count = section[key];
    const subtotal = count * category[rewardKey];
    return `${category.emoji} ${category.name} : **${count} × ${formatMoney(category[rewardKey])} € = ${formatMoney(subtotal)} €**`;
  });
  return rows.join("\n");
}

// Semaine réelle : du lundi à 00:00 au dimanche à 23:59:59
// dans le fuseau défini par REPORT_TIMEZONE.
function getCurrentWeekRange(reference = new Date()) {
  const start = new Date(reference);
  const day = start.getDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysSinceMonday);

  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
}

function getPreviousWeekRange(reference = new Date()) {
  const current = getCurrentWeekRange(reference);
  const start = new Date(current.start);
  start.setDate(start.getDate() - 7);
  const end = new Date(current.start.getTime() - 1);
  return { start, end };
}

async function createWeeklyReportEmbeds(guild, range, options = {}) {
  const guildId = guild.id;
  const reportTitle = options.title || "📊 التقرير الأسبوعي للشرطة";
  const rankingTitle = options.rankingTitle || "🏆 الترتيب الأسبوعي";
  const periodLabel = options.periodLabel || `Période : <t:${Math.floor(range.start.getTime() / 1000)}:d> au <t:${Math.floor(range.end.getTime() / 1000)}:d>`;
  const footerText = options.footerText || "يتم احتساب العمليات المعتمدة فقط.";
  const activePoliceIds = await getActivePoliceUserIds(guild);
  const ranking = calculateWeeklyRanking(guildId, range, activePoliceIds);
  const approvedOperations = [...operations.values()].filter((operation) => {
    if (operation.status !== "approved") return false;
    if (guildId && operation.guildId && operation.guildId !== guildId) return false;
    const time = operation.reviewedAt || operation.submittedAt || operation.createdAt;
    return time >= range.start.getTime() && time <= range.end.getTime();
  });

  const categoryCounts = { minor: 0, medium: 0, major: 0 };
  let totalBonuses = 0;
  for (const operation of approvedOperations) {
    const category = config.rewards[operation.categoryKey];
    if (!category) continue;
    categoryCounts[operation.categoryKey] += 1;
    const operationTime = operation.reviewedAt || operation.submittedAt || operation.createdAt;
    const leaderEligible = activePoliceIds.has(operation.leaderId) && operationTime >= getOfficerResetAt(guildId, operation.leaderId);
    const eligibleMembers = (operation.memberIds || []).filter(
      (userId) => activePoliceIds.has(userId) && operationTime >= getOfficerResetAt(guildId, userId)
    );
    totalBonuses += (leaderEligible ? category.leaderBonus : 0) + eligibleMembers.length * category.memberBonus;
  }

  const startTimestamp = Math.floor(range.start.getTime() / 1000);
  const endTimestamp = Math.floor(range.end.getTime() / 1000);
  const embeds = [];

  const summary = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(reportTitle)
    .setDescription(periodLabel)
    .addFields(
      { name: "🚨 العمليات المعتمدة", value: `**${approvedOperations.length}**`, inline: true },
      { name: "💵 إجمالي المكافآت", value: `**${formatMoney(totalBonuses)} €**`, inline: true },
      { name: "👮 أفراد الشرطة في الترتيب", value: `**${ranking.length}**`, inline: true },
      {
        name: "📂 التوزيع",
        value: [
          `🟢 صغرىs : **${categoryCounts.minor}**`,
          `🟡 متوسطةs : **${categoryCounts.medium}**`,
          `🔴 كبرىs : **${categoryCounts.major}**`,
        ].join("\n"),
      }
    )
    .setFooter({ text: footerText })
    .setTimestamp();
  embeds.push(summary);

  if (!ranking.length) {
    embeds.push(
      new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(rankingTitle)
        .setDescription("لا توجد عمليات معتمدة خلال هذه الفترة.")
    );
    return embeds;
  }

  for (let pageStart = 0; pageStart < ranking.length; pageStart += 10) {
    const page = ranking.slice(pageStart, pageStart + 10);
    const lines = page.map((entry, index) => {
      const position = pageStart + index + 1;
      const medal = position === 1 ? "🥇" : position === 2 ? "🥈" : position === 3 ? "🥉" : `**${position}.**`;
      return [
        `${medal} <@${entry.userId}> — **${formatMoney(entry.totalBonus)} €**`,
        `└ القائد: **${entry.leaderCount}** | مشارك: **${entry.operationCount - entry.leaderCount}** | الإجمالي: **${entry.operationCount}**`,
      ].join("\n");
    });

    embeds.push(
      new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`${rankingTitle} — page ${Math.floor(pageStart / 10) + 1}`)
        .setDescription(lines.join("\n\n"))
    );
  }

  return embeds;
}


function startPrimeTestScheduler(clientInstance) {
  const intervalMinutes = Number(process.env.PRIME_TEST_INTERVAL_MINUTES || 5);
  const enabled = String(process.env.PRIME_TEST_MODE || "false").toLowerCase() === "true";

  if (!enabled || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    console.log("🧪 Affichage automatique des primes désactivé.");
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`🧪 Mode test activé : affichage des primes toutes les ${intervalMinutes} minute(s).`);

  // Premier affichage quelques secondes après le démarrage, puis à intervalle régulier.
  setTimeout(() => publishPrimeTestReport(clientInstance), 10 * 1000);
  setInterval(() => publishPrimeTestReport(clientInstance), intervalMs);
}

const primeTestLocks = new Set();

function isPrimeReportMessage(message, botUserId) {
  if (!message || message.author?.id !== botUserId) return false;

  return message.embeds.some((embed) => {
    const title = embed.title || "";
    return title.startsWith("💼 Résumé hebdomadaire") ||
      title.startsWith("📊 Rapport hebdomadaire") ||
      title.startsWith("🧪 Primes — période de test") ||
      title.startsWith("🏆 الترتيب الأسبوعي") ||
      title.startsWith("🏆 Classement — période de test");
  });
}

async function deletePreviousPrimeReports(channel, botUserId, savedMessageIds = []) {
  const deletedIds = new Set();

  // Suppression prioritaire avec les identifiants sauvegardés dans Neon/JSON.
  for (const messageId of savedMessageIds) {
    const oldMessage = await channel.messages.fetch(messageId).catch(() => null);
    if (!oldMessage) continue;

    await oldMessage.delete().catch((error) => {
      console.warn(`⚠️ Impossible de supprimer l'ancien rapport ${messageId} : ${error.message}`);
    });
    deletedIds.add(messageId);
  }

  // Sécurité supplémentaire après un redémarrage ou une sauvegarde manquante :
  // recherche les anciens rapports du bot dans les 100 derniers messages.
  const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recentMessages) return deletedIds.size;

  for (const message of recentMessages.values()) {
    if (deletedIds.has(message.id) || !isPrimeReportMessage(message, botUserId)) continue;

    await message.delete().catch((error) => {
      console.warn(`⚠️ Impossible de supprimer l'ancien rapport ${message.id} : ${error.message}`);
    });
    deletedIds.add(message.id);
  }

  return deletedIds.size;
}

async function publishPrimeTestReport(clientInstance) {
  for (const guild of clientInstance.guilds.cache.values()) {
    const lockKey = guild.id;
    if (primeTestLocks.has(lockKey)) {
      console.warn(`⚠️ Actualisation des primes déjà en cours sur ${guild.name}.`);
      continue;
    }

    primeTestLocks.add(lockKey);

    try {
      const channel = await getStatsChannel(guild);
      if (!channel) {
        console.warn(`⚠️ Salon de statistiques introuvable sur ${guild.name}.`);
        continue;
      }

      const key = `prime-test:${guild.id}`;
      const previousMessageIds = weeklyReports[key]?.messageIds || [];
      const deletedCount = await deletePreviousPrimeReports(
        channel,
        clientInstance.user.id,
        previousMessageIds
      );

      const intervalMinutes = Number(process.env.PRIME_TEST_INTERVAL_MINUTES || 5);
      const intervalMs = intervalMinutes * 60 * 1000;
      const now = Date.now();

      // Chaque rapport couvre une nouvelle période, sans reprendre les primes
      // déjà affichées lors du passage précédent.
      const savedPeriodEnd = Number(weeklyReports[key]?.periodEndAt);
      const periodStartAt = Number.isFinite(savedPeriodEnd) && savedPeriodEnd > 0 && savedPeriodEnd < now
        ? savedPeriodEnd + 1
        : now - intervalMs;
      const range = {
        start: new Date(periodStartAt),
        end: new Date(now),
      };

      const startTimestamp = Math.floor(range.start.getTime() / 1000);
      const endTimestamp = Math.floor(range.end.getTime() / 1000);
      const embeds = await createWeeklyReportEmbeds(guild, range, {
        title: `🧪 Primes — période de test (${intervalMinutes} min)`,
        rankingTitle: "🏆 Classement — période de test",
        periodLabel: `العمليات المعتمدة بين <t:${startTimestamp}:T> و <t:${endTimestamp}:T>`,
        footerText: "هذا التقرير لا يعيد احتساب المكافآت التي عُرضت في الفترة السابقة.",
      });
      const messageIds = [];

      for (const embed of embeds) {
        const message = await channel.send({ embeds: [embed] });
        messageIds.push(message.id);
      }

      const logsChannel = await getLogsChannel(guild);
      if (logsChannel && logsChannel.id !== channel.id) {
        await sendReportCopyToLogs(logsChannel, embeds, "تحديث المكافآت تلقائياً");
      }

      weeklyReports[key] = {
        guildId: guild.id,
        messageIds,
        periodStartAt,
        periodEndAt: now,
        updatedAt: now,
      };
      await saveWeeklyReports();

      console.log(
        `🧪 Primes actualisées sur ${guild.name} à ${new Date().toLocaleTimeString("fr-BE")} ` +
        `(${deletedCount} ancien(s) message(s) supprimé(s)).`
      );
    } catch (error) {
      console.error(`❌ Erreur pendant l'affichage test des primes sur ${guild.name} :`, error.message);
    } finally {
      primeTestLocks.delete(lockKey);
    }
  }
}

function startWeeklyReportScheduler(clientInstance) {
  console.log("📅 Planificateur hebdomadaire activé (semaine du lundi au dimanche).");

  // Vérification au démarrage puis chaque minute. La clé de période empêche
  // toute publication en double après un redémarrage.
  setTimeout(() => processWeeklyRollover(clientInstance), 5 * 1000);
  setInterval(() => processWeeklyRollover(clientInstance), 60 * 1000);
}

async function processWeeklyRollover(clientInstance) {
  try {
    const currentRange = getCurrentWeekRange(new Date());
    const currentWeekStart = currentRange.start.getTime();

    for (const guild of clientInstance.guilds.cache.values()) {
      // On retire seulement les opérations déjà terminées de l’ancienne période.
      // Les opérations encore en préparation ou en attente de validation restent
      // disponibles : si un contrôleur les valide pendant la nouvelle période,
      // elles seront comptées dans le prochain rapport grâce à reviewedAt.
      const oldOperations = [...operations.values()].filter((operation) => {
        if (operation.guildId && operation.guildId !== guild.id) return false;
        if (operation.status !== "approved" && operation.status !== "rejected") return false;
        const operationTime = operation.reviewedAt || operation.submittedAt || operation.createdAt || 0;
        return operationTime < currentWeekStart;
      });

      // Rien à retirer du calcul pour ce serveur. Les opérations en attente
      // restent toutefois conservées pour pouvoir être validées plus tard.
      if (!oldOperations.length) continue;

      const resetKey = `reset-test:${guild.id}:${currentRange.start.getTime()}`;

      // Publie une dernière fois le rapport de la semaine précédente avant nettoyage.
      // En cas de permissions manquantes, le nettoyage continue quand même.
      if (!weeklyReports[resetKey]) {
        const previousRange = getPreviousWeekRange(currentRange.start);
        const channel = await getStatsChannel(guild);
        const reportMessageIds = [];

        if (channel) {
          try {
            // Supprime uniquement l'ancien classement. Le résumé du rapport
            // précédent reste dans le salon comme historique.
            const activeRankingKey = `active-ranking:${guild.id}`;
            const previousRankingIds = weeklyReports[activeRankingKey]?.messageIds || [];

            for (const messageId of previousRankingIds) {
              const oldMessage = await channel.messages.fetch(messageId).catch(() => null);
              if (oldMessage) {
                await oldMessage.delete().catch((deleteError) => {
                  console.error(`❌ Impossible de supprimer un ancien classement (${messageId}) :`, deleteError.message);
                });
              }
            }

            const embeds = await createWeeklyReportEmbeds(guild, previousRange);

            const logsChannel = await getLogsChannel(guild);
            if (logsChannel && logsChannel.id !== channel.id) {
              await sendReportCopyToLogs(logsChannel, embeds, "الإغلاق التلقائي للأسبوع");
            }

            // Le premier embed est toujours le résumé : on le conserve définitivement.
            if (embeds[0]) {
              const summaryMessage = await channel.send({ embeds: [embeds[0]] });
              reportMessageIds.push(summaryMessage.id);
            }

            // Les embeds suivants représentent le classement actuel.
            // Ils seront supprimés à la prochaine mise à jour.
            const rankingMessageIds = [];
            const hasRealRanking = embeds.length > 1 && !embeds[1].data?.description?.includes("Aucune opération validée");

            if (hasRealRanking) {
              for (const embed of embeds.slice(1)) {
                const rankingMessage = await channel.send({ embeds: [embed] });
                rankingMessageIds.push(rankingMessage.id);
              }
            }

            weeklyReports[activeRankingKey] = {
              guildId: guild.id,
              messageIds: rankingMessageIds,
              updatedAt: Date.now(),
            };
            saveWeeklyReports();
          } catch (error) {
            console.error(`❌ Impossible de publier le rapport final sur ${guild.name} :`, error.message);
          }
        }

        weeklyReports[resetKey] = {
          guildId: guild.id,
          previousWeekStart: previousRange.start.getTime(),
          previousWeekEnd: previousRange.end.getTime(),
          currentWeekStart,
          messageIds: reportMessageIds,
          resetAt: Date.now(),
        };
        saveWeeklyReports();
      }

      // Conserve les messages d'opération dans Discord comme historique.
      // Seules les données de calcul internes sont retirées afin que les primes
      // et le classement repartent à zéro pour la nouvelle période.
      for (const operation of oldOperations) {
        operations.delete(operation.id);
      }

      saveOperations();
      console.log(
        `📅 Nouvelle semaine sur ${guild.name} : ${oldOperations.length} ancienne(s) opération(s) retirée(s) du calcul, messages conservés, primes remises à zéro.`
      );
    }
  } catch (error) {
    console.error("❌ Erreur pendant la remise à zéro hebdomadaire :", error);
  }
}

async function getStatsChannel(guild) {
  if (!isConfiguredId(config.statsChannelId)) return null;
  const channel = await guild.channels.fetch(config.statsChannelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function getLogsChannel(guild) {
  if (!isConfiguredId(config.logsChannelId)) return null;
  const channel = await guild.channels.fetch(config.logsChannelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function sendReportCopyToLogs(logsChannel, embeds, reason) {
  try {
    await logsChannel.send({
      content: `🗂️ **${reason}** • <t:${Math.floor(Date.now() / 1000)}:F>`,
    });

    for (const embed of embeds) {
      await logsChannel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error(`❌ Impossible d’envoyer le rapport dans les logs : ${error.message}`);
  }
}

function officerResetKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function loadOfficerResets() {
  const data = await storage.loadState("officer_resets", {}, OFFICER_RESETS_FILE);
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function saveOfficerResets() {
  storage.saveState("officer_resets", officerResets, OFFICER_RESETS_FILE);
}

function scheduleOfficerReset(guildId, userId) {
  const key = officerResetKey(guildId, userId);
  officerResets[key] = {
    guildId,
    userId,
    pendingDeleteAt: Date.now() + 24 * 60 * 60 * 1000,
    resetAt: officerResets[key]?.resetAt || 0,
  };
  saveOfficerResets();
}

function cancelOfficerReset(guildId, userId) {
  const key = officerResetKey(guildId, userId);
  const record = officerResets[key];
  if (!record?.pendingDeleteAt) return false;
  record.pendingDeleteAt = null;
  officerResets[key] = record;
  saveOfficerResets();
  return true;
}

function getOfficerResetAt(guildId, userId) {
  return Number(officerResets[officerResetKey(guildId, userId)]?.resetAt || 0);
}

async function processPendingOfficerResets(clientInstance) {
  const now = Date.now();
  let changed = false;

  for (const [key, record] of Object.entries(officerResets)) {
    if (!record?.pendingDeleteAt || record.pendingDeleteAt > now) continue;

    const guild = clientInstance.guilds.cache.get(record.guildId);
    const member = guild ? await guild.members.fetch(record.userId).catch(() => null) : null;

    if (member?.roles.cache.has(config.policeRoleId)) {
      record.pendingDeleteAt = null;
    } else {
      record.resetAt = now;
      record.pendingDeleteAt = null;
      console.log(`🗑 Historique remis à zéro pour ${record.userId} après 24 h sans rôle Police.`);
    }

    officerResets[key] = record;
    changed = true;
  }

  if (changed) saveOfficerResets();
}

function startOfficerResetScheduler(clientInstance) {
  setInterval(() => {
    processPendingOfficerResets(clientInstance).catch((error) => {
      console.error("❌ Erreur pendant les remises à zéro différées :", error);
    });
  }, 60 * 1000);
}

async function hasPoliceRole(guild, userId) {
  if (!guild || !isConfiguredId(config.policeRoleId)) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  return Boolean(member?.roles.cache.has(config.policeRoleId));
}

async function getActivePoliceUserIds(guild) {
  if (!guild || !isConfiguredId(config.policeRoleId)) return new Set();
  // Évite une récupération globale des membres, fortement limitée par Discord.
  const members = guild.members.cache;
  return new Set(
    members
      .filter((member) => !member.user.bot && member.roles.cache.has(config.policeRoleId))
      .map((member) => member.id)
  );
}

async function loadWeeklyReports() {
  const data = await storage.loadState("weekly_reports", {}, REPORTS_FILE);
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function saveWeeklyReports() {
  return storage.saveState("weekly_reports", weeklyReports, REPORTS_FILE);
}

function getWeeklyReportKey(guildId, range) {
  return `${guildId}:${range.start.toISOString().slice(0, 10)}`;
}

function archiveWeeklyReport(guildId, range, messageIds, publishedBy, automatic) {
  const key = getWeeklyReportKey(guildId, range);
  weeklyReports[key] = {
    guildId,
    weekStart: range.start.getTime(),
    weekEnd: range.end.getTime(),
    messageIds,
    publishedBy,
    automatic,
    publishedAt: Date.now(),
  };
  saveWeeklyReports();
}

async function loadOperations() {
  const saved = await storage.loadState("operations", [], DATA_FILE);
  if (!Array.isArray(saved)) {
    throw new Error("Les opérations sauvegardées doivent contenir un tableau.");
  }
  operations.clear();
  for (const operation of saved) {
    if (operation?.id) operations.set(operation.id, operation);
  }
}

function saveOperations() {
  storage.saveState("operations", [...operations.values()], DATA_FILE);
}

const TEMP_MESSAGE_TTL_MS = 30 * 1000;
const ABANDONED_REPORT_TTL_MS = 5 * 60 * 1000;

function scheduleMessageDelete(message, delay = TEMP_MESSAGE_TTL_MS) {
  if (!message?.delete) return;
  setTimeout(() => message.delete().catch(() => {}), delay);
}

function scheduleEphemeralDelete(interaction, delay = TEMP_MESSAGE_TTL_MS) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), delay);
}

async function respondEphemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) {
    const message = await interaction.followUp(payload).catch(() => null);
    scheduleMessageDelete(message);
    return message;
  }
  const result = await interaction.reply(payload).catch(() => null);
  if (result) scheduleEphemeralDelete(interaction);
  return result;
}

function scheduleAbandonedOperationCleanup(operationId) {
  const operation = operations.get(operationId);
  if (!operation || operation.status !== "preparation") return;
  const remaining = Math.max(1000, ABANDONED_REPORT_TTL_MS - (Date.now() - operation.createdAt));
  setTimeout(() => cleanupAbandonedOperation(operationId), remaining);
}

async function cleanupAbandonedOperation(operationId) {
  const operation = operations.get(operationId);
  if (!operation || operation.status !== "preparation") return;
  if (Date.now() - operation.createdAt < ABANDONED_REPORT_TTL_MS) {
    scheduleAbandonedOperationCleanup(operationId);
    return;
  }
  const guild = client.guilds.cache.get(operation.guildId);
  const channel = guild ? await guild.channels.fetch(operation.reportChannelId).catch(() => null) : null;
  if (channel?.isTextBased() && operation.reportMessageId) {
    const message = await channel.messages.fetch(operation.reportMessageId).catch(() => null);
    if (message) await message.delete().catch(() => {});
  }
  pendingProofs.delete(`${operation.guildId}:${operation.reportChannelId}:${operation.leaderId}`);
  operations.delete(operationId);
  saveOperations();
  console.log(`🧹 Rapport abandonné ${operationId} supprimé automatiquement après 5 minutes.`);
}

function getOperationFromInteraction(interaction) {
  const operationId = interaction.customId.split(":")[1];
  return operations.get(operationId);
}

async function verifyLeader(interaction, operation) {
  if (!operation) {
    await respondEphemeral(interaction, "❌ هذه العملية غير موجودة.");
    return false;
  }
  if (interaction.user.id !== operation.leaderId) {
    await respondEphemeral(interaction, "❌ قائد هذه العملية فقط يمكنه استخدام هذا الزر.");
    return false;
  }
  return true;
}

async function verifyPreparation(interaction, operation) {
  if (!["preparation", "correction"].includes(operation.status)) {
    await respondEphemeral(interaction, "❌ لم يعد من الممكن تعديل هذه العملية.");
    return false;
  }
  return true;
}

async function isSupervisor(interaction) {
  // Cette fonction reste réservée au rôle Operations Controller
  // pour les commandes qui demandent spécifiquement un superviseur.
  if (!interaction.inGuild() || !isConfiguredId(config.supervisorRoleId)) {
    return false;
  }

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  return Boolean(member?.roles?.cache?.has(config.supervisorRoleId));
}

async function canReviewOperations(interaction) {
  if (!interaction.inGuild()) return false;

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member) return false;

  const isController =
    isConfiguredId(config.supervisorRoleId) &&
    member.roles.cache.has(config.supervisorRoleId);

  const isChief =
    isConfiguredId(CHIEF_ROLE_ID) &&
    member.roles.cache.has(CHIEF_ROLE_ID);

  return isController || isChief;
}

async function verifySupervisor(interaction, operation = null) {
  const member = interaction.inGuild()
    ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
    : null;

  const isController = Boolean(
    member &&
    isConfiguredId(config.supervisorRoleId) &&
    member.roles.cache.has(config.supervisorRoleId)
  );

  const isChief = Boolean(
    member &&
    isConfiguredId(CHIEF_ROLE_ID) &&
    member.roles.cache.has(CHIEF_ROLE_ID)
  );

  console.log("━━━━━━━━ CONTRÔLE VALIDATION ━━━━━━━━");
  console.log(`Utilisateur : ${interaction.user.tag} (${interaction.user.id})`);
  console.log(`SUPERVISOR_ROLE_ID attendu : ${config.supervisorRoleId || "NON CONFIGURÉ"}`);
  console.log(`CHIEF_ROLE_ID attendu : ${CHIEF_ROLE_ID || "NON CONFIGURÉ"}`);
  console.log(
    "Rôles du membre :",
    member
      ? member.roles.cache.map((role) => `${role.name} (${role.id})`).join(", ")
      : "Impossible de récupérer le membre"
  );

  if (!isConfiguredId(config.supervisorRoleId) && !isConfiguredId(CHIEF_ROLE_ID)) {
    await respondEphemeral(
      interaction,
      "❌ لم يتم إعداد أي رتبة للمراجعة. أضف `SUPERVISOR_ROLE_ID` و/أو `CHIEF_ROLE_ID` في ملف `.env`."
    );
    return false;
  }

  if (!isController && !isChief) {
    console.log("Résultat : REFUSÉ — aucun rôle autorisé détecté.");
    await respondEphemeral(
      interaction,
      "❌ فقط الأعضاء الذين لديهم رتبة **Operations Controller** أو **Chief of Police** يمكنهم قبول أو رفض هذا التقرير."
    );
    return false;
  }

  if (operation && (operation.leaderId === interaction.user.id || (operation.memberIds || []).includes(interaction.user.id))) {
    console.log("Résultat : REFUSÉ — auto-validation interdite.");
    await respondEphemeral(
      interaction,
      "🚫 لا يمكنك مراجعة أو قبول أو رفض تقرير عملية كنت قائداً أو مشاركاً فيها."
    );
    return false;
  }

  console.log(
    `Résultat : AUTORISÉ — ${isChief ? "Chief of Police" : "Operations Controller"} détecté.`
  );
  return true;
}

async function displayConfigurationStatus(readyClient) {
  console.log("🔎 Vérification de la configuration :");

  if (!isConfiguredId(config.supervisorRoleId)) {
    console.error("❌ SUPERVISOR_ROLE_ID absent ou invalide dans le fichier .env");
  }

  if (!isConfiguredId(config.policeRoleId)) {
    console.error("❌ POLICE_ROLE_ID absent ou invalide dans le fichier .env");
  }

  if (!isConfiguredId(CHIEF_ROLE_ID)) {
    console.error("❌ CHIEF_ROLE_ID absent ou invalide dans le fichier .env");
  }

  for (const guild of readyClient.guilds.cache.values()) {
    await guild.roles.fetch().catch(() => null);
    await guild.channels.fetch().catch(() => null);

    console.log(`\n🏢 Serveur : ${guild.name} (${guild.id})`);

    const controllerRole = isConfiguredId(config.supervisorRoleId)
      ? guild.roles.cache.get(config.supervisorRoleId)
      : null;
    const policeRole = isConfiguredId(config.policeRoleId)
      ? guild.roles.cache.get(config.policeRoleId)
      : null;
    const chiefRole = isConfiguredId(CHIEF_ROLE_ID)
      ? guild.roles.cache.get(CHIEF_ROLE_ID)
      : null;
    const operationsChannel = isConfiguredId(config.operationsChannelId)
      ? guild.channels.cache.get(config.operationsChannelId)
      : null;
    const statsChannel = isConfiguredId(config.statsChannelId)
      ? guild.channels.cache.get(config.statsChannelId)
      : null;
    const logsChannel = isConfiguredId(config.logsChannelId)
      ? guild.channels.cache.get(config.logsChannelId)
      : null;

    if (controllerRole) {
      console.log(`✅ Operations Controller : ${controllerRole.name} (${controllerRole.id})`);
    } else {
      console.error(`❌ Rôle Operations Controller introuvable avec l’ID : ${config.supervisorRoleId || "vide"}`);
    }

    if (policeRole) {
      console.log(`✅ Rôle Police : ${policeRole.name} (${policeRole.id})`);
    } else {
      console.error(`❌ Rôle Police introuvable avec l’ID : ${config.policeRoleId || "vide"}`);
    }

    if (chiefRole) {
      console.log(`✅ Chief of Police : ${chiefRole.name} (${chiefRole.id})`);
    } else {
      console.error(`❌ Rôle Chief of Police introuvable avec l’ID : ${CHIEF_ROLE_ID || "vide"}`);
    }

    if (operationsChannel) {
      console.log(`✅ Salon opérations : #${operationsChannel.name} (${operationsChannel.id})`);
    } else {
      console.error(`❌ Salon opérations introuvable avec l’ID : ${config.operationsChannelId || "vide"}`);
    }

    if (isConfiguredId(config.statsChannelId)) {
      if (statsChannel) {
        console.log(`✅ Salon statistiques : #${statsChannel.name} (${statsChannel.id})`);
      } else {
        console.error(`❌ Salon statistiques introuvable avec l’ID : ${config.statsChannelId}`);
      }
    }

    if (isConfiguredId(config.logsChannelId)) {
      if (logsChannel) {
        console.log(`✅ Salon logs : #${logsChannel.name} (${logsChannel.id})`);
      } else {
        console.error(`❌ Salon logs introuvable avec l’ID : ${config.logsChannelId}`);
      }
    }
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

function getEligiblePoliceMembers(guild, operation) {
  return guild.members.cache
    .filter(
      (member) =>
        !member.user.bot &&
        member.id !== operation.leaderId &&
        member.roles.cache.has(config.policeRoleId)
    )
    .sort((first, second) =>
      first.displayName.localeCompare(second.displayName, "fr", {
        sensitivity: "base",
      })
    );
}

function createMemberSelectionView(operation, guild, requestedPage = 0) {
  const policeMembers = [...getEligiblePoliceMembers(guild, operation).values()];
  const membersPerPage = 100;
  const totalPages = Math.max(1, Math.ceil(policeMembers.length / membersPerPage));
  const page = Math.min(Math.max(Number(requestedPage) || 0, 0), totalPages - 1);
  const pageMembers = policeMembers.slice(page * membersPerPage, page * membersPerPage + membersPerPage);

  if (pageMembers.length === 0) {
    return {
      embeds: [
        createOperationEmbed(operation).setDescription(
          "❌ لا يوجد عضو آخر متاح يحمل رتبة Police."
        ),
      ],
      components: [createOperationButtons(operation.id)],
    };
  }

  const components = [];
  const chunkCount = Math.ceil(pageMembers.length / 25);

  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    const chunkMembers = pageMembers.slice(chunk * 25, chunk * 25 + 25);
    const globalStart = page * membersPerPage + chunk * 25 + 1;
    const globalEnd = globalStart + chunkMembers.length - 1;

    const memberSelect = new StringSelectMenuBuilder()
      .setCustomId(`operation_members_select:${operation.id}:${page}:${chunk}`)
      .setPlaceholder(`أفراد الشرطة ${globalStart}-${globalEnd} من ${policeMembers.length}`)
      .setMinValues(0)
      .setMaxValues(chunkMembers.length)
      .addOptions(
        chunkMembers.map((member) => ({
          label: member.displayName.slice(0, 100),
          value: member.id,
          description: `معرّف Discord: ${member.id}`.slice(0, 100),
          default: (operation.memberIds || []).includes(member.id),
        }))
      );

    components.push(new ActionRowBuilder().addComponents(memberSelect));
  }

  const previousButton = new ButtonBuilder()
    .setCustomId(`operation_members_page:${operation.id}:${page - 1}`)
    .setLabel("السابق")
    .setEmoji("⬅️")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId(`operation_members_page:${operation.id}:${page + 1}`)
    .setLabel("التالي")
    .setEmoji("➡️")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);

  const doneButton = new ButtonBuilder()
    .setCustomId(`operation_members_done:${operation.id}`)
    .setLabel("إنهاء")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success);

  const cancelButton = new ButtonBuilder()
    .setCustomId(`operation_members_cancel:${operation.id}`)
    .setLabel("إلغاء")
    .setEmoji("↩️")
    .setStyle(ButtonStyle.Danger);

  const controlButtons = [];
  if (totalPages > 1) controlButtons.push(previousButton, nextButton);
  controlButtons.push(doneButton, cancelButton);
  components.push(new ActionRowBuilder().addComponents(...controlButtons));

  const rangeStart = page * membersPerPage + 1;
  const rangeEnd = page * membersPerPage + pageMembers.length;
  const pageText = totalPages > 1
    ? `الصفحة **${page + 1}/${totalPages}** • أفراد الشرطة **${rangeStart}-${rangeEnd}** من **${policeMembers.length}**`
    : `يتم عرض جميع أفراد الشرطة في هذه الصفحة: **${policeMembers.length}** متاح`;

  return {
    embeds: [
      createOperationEmbed(operation).setDescription(
        [
          "👥 **اختيار المشاركين**",
          "",
          pageText,
          `إجمالي المحددين: **${(operation.memberIds || []).length}**`,
          "",
          "يمكنك اختيار أفراد الشرطة من القوائم أدناه.",
          "Clique ensuite sur **إنهاء** pour enregistrer la liste complète.",
          "يتم استبعاد قائد العملية تلقائياً.",
        ].join("\n")
      ),
    ],
    components,
  };
}

function createOperationEmbed(operation) {
  const category = config.rewards[operation.categoryKey];
  const members = operation.memberIds?.length
    ? operation.memberIds.map((id, index) => `${index + 1}. <@${id}>`).join("\n")
    : "لم تتم إضافة أي عضو";
  const total = category.leaderBonus + (operation.memberIds?.length || 0) * category.memberBonus;

  const operationType = operation.operationKey ? config.operationTypes[operation.operationKey] : null;
  const operationName = operation.operationName || operationType?.name || category.name;
  const operationEmoji = operation.operationEmoji || operationType?.emoji || "🚨";

  const embed = new EmbedBuilder()
    .setColor(getCategoryColor(operation.categoryKey))
    .setTitle(`${operationEmoji} ${operationName} — ${operation.id}`)
    .addFields(
      { name: "🆔 الرقم", value: `\`${operation.id}\``, inline: true },
      { name: "📅 تاريخ الإنشاء", value: `<t:${Math.floor(operation.createdAt / 1000)}:f>`, inline: true },
      { name: "🚔 العملية", value: `${operationEmoji} **${operationName}**` },
      { name: "📂 الفئة التلقائية", value: `${category.emoji} ${category.name}` },
      { name: "👑 قائد العملية", value: `<@${operation.leaderId}>` },
      { name: `👥 المشاركون (${operation.memberIds?.length || 0})`, value: members },
      {
        name: "📷 الدليل",
        value: operation.proofUrl ? "✅ تم إدراج الدليل مباشرة في التقرير" : "لم تتم إضافة دليل",
      },
      { name: "💰 مكافأة القائد", value: `${formatMoney(category.leaderBonus)} €`, inline: true },
      { name: "💰 مكافأة كل عضو", value: `${formatMoney(category.memberBonus)} €`, inline: true },
      { name: "💵 إجمالي العملية", value: `${formatMoney(total)} €` },
      { name: "📌 الحالة", value: getStatusText(operation) }
    );

  if (operation.status === "rejected" && operation.rejectionReason) {
    embed.addFields({ name: "📝 سبب الرفض", value: operation.rejectionReason.slice(0, 1024) });
  }

  if (operation.status === "correction" && operation.correctionReason) {
    embed.addFields({ name: "🟠 التصحيح المطلوب", value: operation.correctionReason.slice(0, 1024) });
  }

  const duplicateWarningText = buildDuplicateWarningText(operation);
  if (duplicateWarningText) {
    embed.addFields({
      name: "⚠️ تنبيه للمراجعين — احتمال تكرار",
      value: duplicateWarningText.slice(0, 1024),
    });
  }

  if (["pending", "approved", "rejected", "correction"].includes(operation.status) && Number.isFinite(Number(operation.suspicionScore))) {
    embed.addFields({
      name: "🛡️ تقييم المخاطر",
      value: `${getSuspicionEmoji(operation.suspicionLevel)} **${getSuspicionLabel(operation.suspicionLevel)}** — ${Number(operation.suspicionScore)}/100`,
      inline: true,
    });
  }

  embed
    .setFooter({ text: operation.status === "preparation" ? "قائد العملية فقط يمكنه تعديل هذا التقرير." : `التقرير ${operation.id}` })
    .setTimestamp(operation.createdAt);

  if (operation.proofUrl) embed.setImage(operation.proofUrl);
  return embed;
}

function createOperationTypeSelect() {
  const categoryLabels = { minor: "صغرى", medium: "متوسطة", major: "كبرى" };
  const options = Object.entries(config.operationTypes).map(([key, operation]) => {
    const reward = config.rewards[operation.categoryKey];
    return {
      label: operation.name.slice(0, 100),
      value: key,
      emoji: operation.emoji,
      description: `${categoryLabels[operation.categoryKey]} • القائد ${formatMoney(reward.leaderBonus)} € • العضو ${formatMoney(reward.memberBonus)} €`.slice(0, 100),
    };
  });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("operation_type_select")
      .setPlaceholder("اختر اسم العملية")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options)
  );
}

function createOperationButtons(operationId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`operation_add_members:${operationId}`).setLabel("إضافة أفراد الشرطة").setEmoji("➕").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`operation_add_proof:${operationId}`).setLabel("إضافة دليل").setEmoji("📷").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`operation_submit:${operationId}`).setLabel("إرسال").setEmoji("📤").setStyle(ButtonStyle.Success)
  );
}

function createReviewButtons(operationId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`operation_check:${operationId}`).setLabel("فحص").setEmoji("🔎").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`operation_approve:${operationId}`).setLabel("قبول").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`operation_correction:${operationId}`).setLabel("تصحيح").setEmoji("🟠").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`operation_reject:${operationId}`).setLabel("رفض").setEmoji("❌").setStyle(ButtonStyle.Danger)
  );
}

async function getReviewChannel(interaction) {
  if (isConfiguredId(config.operationsChannelId)) {
    const channel = await interaction.guild.channels.fetch(config.operationsChannelId).catch(() => null);
    if (channel?.isTextBased()) return channel;
  }
  return interaction.channel?.isTextBased() ? interaction.channel : null;
}

async function notifyLeader(guild, operation, approved) {
  // Envoie toujours la décision en MP au chef/créateur du rapport.
  // On tente d'abord via le membre du serveur, puis directement via l'utilisateur Discord.
  const member = await guild.members.fetch(operation.leaderId).catch(() => null);
  const recipient = member?.user || await client.users.fetch(operation.leaderId).catch(() => null);
  if (!recipient) return;

  const text = approved
    ? `✅ تم قبول تقريرك **${operation.id}** وتم احتساب المكافأة.`
    : `❌ تم رفض تقريرك **${operation.id}**.\n\n📝 **سبب الرفض :**\n${operation.rejectionReason || "غير محدد"}${operation.reviewedBy ? `\n\n👮 تم الرفض بواسطة: <@${operation.reviewedBy}>` : ""}`;

  await recipient.send({ content: text }).catch((error) => {
    console.warn(`[DM] Impossible d'envoyer la décision ${operation.id} à ${operation.leaderId}:`, error?.message || error);
  });
}

async function notifyتصحيح(guild, operation) {
  const member = await guild.members.fetch(operation.leaderId).catch(() => null);
  const recipient = member?.user || await client.users.fetch(operation.leaderId).catch(() => null);
  if (!recipient) return;

  const text = [
    `🟠 طُلب تصحيح لتقريرك **${operation.id}**.`,
    "",
    "📝 **المطلوب تصحيحه:**",
    operation.correctionReason || "غير محدد",
    operation.reviewedBy ? `\n👮 طلبه: <@${operation.reviewedBy}>` : "",
    "",
    "يمكنك تعديل نفس التقرير ثم الضغط على **إرسال** مرة أخرى.",
  ].join("\n");

  await recipient.send({ content: text }).catch((error) => {
    console.warn(`[DM] Impossible d'envoyer la correction ${operation.id}:`, error?.message || error);
  });
}

async function sendReviewLog(guild, operation, action) {
  const channel = await getLogsChannel(guild).catch(() => null);
  if (!channel?.isTextBased()) return;

  const labels = {
    approved: ["✅ تقرير مقبول", 0x57f287],
    rejected: ["❌ تقرير مرفوض", 0xed4245],
    correction: ["🟠 التصحيح المطلوب", 0xfee75c],
  };
  const [title, color] = labels[action] || ["📋 تمت معالجة التقرير", 0x5865f2];
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${title} — ${operation.id}`)
    .addFields(
      { name: "👑 القائد", value: `<@${operation.leaderId}>`, inline: true },
      { name: "👮 المراجع", value: operation.reviewedBy ? `<@${operation.reviewedBy}>` : "غير معروف", inline: true },
      { name: "🚔 العملية", value: operation.operationName || operation.operationKey || "غير معروفe" }
    )
    .setTimestamp(operation.reviewedAt || Date.now());
  if (action === "rejected" && operation.rejectionReason) {
    embed.addFields({ name: "📝 سبب الرفض", value: operation.rejectionReason.slice(0, 1024) });
  }
  if (action === "correction" && operation.correctionReason) {
    embed.addFields({ name: "📝 التصحيح المطلوب", value: operation.correctionReason.slice(0, 1024) });
  }
  await channel.send({ embeds: [embed] }).catch(() => {});
}

function findRecentDuplicateSignals(currentOperation) {
  const now = Date.now();
  const proofWindowStart = now - 7 * 24 * 60 * 60 * 1000; // نفس الصورة خلال 7 أيام
  const membersWindowStart = now - 2 * 60 * 60 * 1000; // أعضاء متشابهون خلال ساعتين
  const validStatuses = new Set(["pending", "approved", "rejected", "correction"]);

  const previous = [...operations.values()].filter((op) =>
    op.id !== currentOperation.id &&
    op.guildId === currentOperation.guildId &&
    validStatuses.has(op.status)
  );

  // 1) نفس الصورة: نعتمد SHA-256، مع fallback للرابط للبيانات القديمة.
  const proof = previous
    .filter((op) => (op.submittedAt || op.createdAt || 0) >= proofWindowStart)
    .find((op) =>
      (currentOperation.proofHash && op.proofHash && op.proofHash === currentOperation.proofHash) ||
      (!currentOperation.proofHash && currentOperation.proofUrl && op.proofUrl === currentOperation.proofUrl)
    ) || null;

  // 2) تقريباً نفس المشاركين: Jaccard >= 75%، مع عضوين على الأقل، خلال ساعتين.
  const currentMembers = new Set([currentOperation.leaderId, ...(currentOperation.memberIds || [])].filter(Boolean));
  let members = null;
  if (currentMembers.size >= 2) {
    for (const op of previous) {
      const at = op.submittedAt || op.createdAt || 0;
      if (at < membersWindowStart) continue;
      const otherMembers = new Set([op.leaderId, ...(op.memberIds || [])].filter(Boolean));
      if (otherMembers.size < 2) continue;

      const intersection = [...currentMembers].filter((id) => otherMembers.has(id)).length;
      const union = new Set([...currentMembers, ...otherMembers]).size;
      const similarity = union ? intersection / union : 0;
      if (similarity >= 0.75) {
        const candidate = { operation: op, percent: Math.round(similarity * 100), intersection, union };
        if (!members || candidate.percent > members.percent) members = candidate;
      }
    }
  }

  return { proof, members };
}

function buildDuplicateWarningText(operation) {
  const lines = [];
  if (operation.duplicateProofOf) {
    lines.push(`📷 **نفس الدليل/الصورة** استُخدم سابقاً في **${operation.duplicateProofOf}**.`);
  }
  if (operation.duplicateMembersOf) {
    const percent = Number(operation.duplicateMembersPercent) || 0;
    lines.push(`👥 **تشكيلة أفراد متشابهة بنسبة ${percent}%** مع **${operation.duplicateMembersOf}** خلال فترة قصيرة.`);
  }
  if ((Number(operation.antiFarmCount) || 0) > 0) {
    const refs = operation.antiFarmOperationIds?.length ? ` (${operation.antiFarmOperationIds.join(", ")})` : "";
    lines.push(`⏱️ **Anti-Farm:** تم العثور على ${operation.antiFarmCount} عملية مشابهة لنفس الفريق خلال 30 دقيقة${refs}.`);
  }
  if (lines.length) lines.push("🔎 يرجى من المراجع التحقق قبل القبول.");
  return lines.join("\n");
}

function getOperationTeamSet(operation) {
  return new Set([operation.leaderId, ...(operation.memberIds || [])].filter(Boolean));
}

function getTeamSimilarity(a, b) {
  const setA = getOperationTeamSet(a);
  const setB = getOperationTeamSet(b);
  if (!setA.size || !setB.size) return 0;
  const intersection = [...setA].filter((id) => setB.has(id)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function findAntiFarmSignals(currentOperation) {
  const windowStart = Date.now() - 30 * 60 * 1000;
  const validStatuses = new Set(["pending", "approved", "rejected", "correction"]);
  const matches = [...operations.values()]
    .filter((op) =>
      op.id !== currentOperation.id &&
      op.guildId === currentOperation.guildId &&
      validStatuses.has(op.status) &&
      (op.submittedAt || op.createdAt || 0) >= windowStart &&
      getTeamSimilarity(currentOperation, op) >= 0.75
    )
    .sort((a, b) => (b.submittedAt || b.createdAt || 0) - (a.submittedAt || a.createdAt || 0));

  return {
    count: matches.length,
    operationIds: matches.slice(0, 5).map((op) => op.id),
  };
}

function calculateSuspicion(operation) {
  let score = 0;
  const reasons = [];

  if (operation.duplicateProofOf) {
    score += 60;
    reasons.push(`📷 نفس الدليل استُخدم في ${operation.duplicateProofOf}`);
  }
  if (operation.duplicateMembersOf) {
    const percent = Number(operation.duplicateMembersPercent) || 0;
    score += percent >= 90 ? 30 : 20;
    reasons.push(`👥 تشابه أعضاء ${percent}% مع ${operation.duplicateMembersOf}`);
  }
  const farmCount = Number(operation.antiFarmCount) || 0;
  if (farmCount > 0) {
    const farmPoints = Math.min(30, farmCount * 10);
    score += farmPoints;
    reasons.push(`⏱️ ${farmCount} عملية مشابهة لنفس الفريق خلال 30 دقيقة`);
  }

  score = Math.min(100, score);
  const level = score >= 60 ? "high" : score >= 25 ? "medium" : "low";
  if (!reasons.length) reasons.push("✅ لم يتم اكتشاف مؤشر غير طبيعي");
  return { score, level, reasons };
}

function getSuspicionEmoji(level) {
  return level === "high" ? "🔴" : level === "medium" ? "🟠" : "🟢";
}

function getSuspicionLabel(level) {
  return level === "high" ? "مرتفع" : level === "medium" ? "يحتاج مراجعة" : "طبيعي";
}

function buildOperationAudit(operation) {
  const suspicion = calculateSuspicion(operation);
  const lines = [
    `🔎 **فحص التقرير ${operation.id}**`,
    "",
    `${getSuspicionEmoji(suspicion.level)} مستوى المخاطر: **${getSuspicionLabel(suspicion.level)} (${suspicion.score}/100)**`,
    "",
    ...suspicion.reasons,
  ];

  if (operation.antiFarmOperationIds?.length) {
    lines.push("", `⏱️ عمليات مشابهة حديثاً: **${operation.antiFarmOperationIds.join(", ")}**`);
  }
  lines.push("", "ℹ️ هذا الفحص تحذيري ولا يقبل أو يرفض التقرير تلقائياً.");
  return lines.join("\n").slice(0, 1900);
}

async function handleRevisionCenterCommand(interaction) {
  if (!(await canReviewOperations(interaction))) {
    await interaction.reply({ content: "❌ هذا الأمر مخصص لمسؤولي المراجعة فقط.", flags: MessageFlags.Ephemeral });
    scheduleEphemeralDelete(interaction);
    return;
  }

  const pending = [...operations.values()]
    .filter((op) => op.guildId === interaction.guildId && op.status === "pending")
    .map((op) => {
      const suspicion = calculateSuspicion(op);
      return { op, suspicion };
    })
    .sort((a, b) => b.suspicion.score - a.suspicion.score || (a.op.submittedAt || 0) - (b.op.submittedAt || 0))
    .slice(0, 15);

  if (!pending.length) {
    await interaction.reply({ content: "✅ لا توجد تقارير بانتظار المراجعة حالياً.", flags: MessageFlags.Ephemeral });
    scheduleEphemeralDelete(interaction);
    return;
  }

  const lines = pending.map(({ op, suspicion }, index) => {
    const channelId = op.reviewChannelId || op.reportChannelId;
    const messageId = op.reviewMessageId || op.reportMessageId;
    const link = channelId && messageId
      ? `https://discord.com/channels/${interaction.guildId}/${channelId}/${messageId}`
      : null;
    const age = Math.floor((op.submittedAt || op.createdAt || Date.now()) / 1000);
    return [
      `**${index + 1}. ${op.id}** ${getSuspicionEmoji(suspicion.level)} **${suspicion.score}/100**`,
      `└ 👑 <@${op.leaderId}> • <t:${age}:R>${link ? ` • [فتح التقرير](${link})` : ""}`,
    ].join("\n");
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🛡️ مركز مراجعة العمليات")
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: "مرتبة حسب مستوى المخاطر ثم وقت الإرسال • أول 15 تقريراً" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  scheduleEphemeralDelete(interaction);
}

async function handleControllerStatsCommand(interaction) {
  if (!(await canReviewOperations(interaction))) {
    await interaction.reply({ content: "❌ هذا الأمر مخصص لمسؤولي المراجعة فقط.", flags: MessageFlags.Ephemeral });
    scheduleEphemeralDelete(interaction);
    return;
  }

  const range = getCurrentWeekRange();
  const stats = new Map();
  for (const op of operations.values()) {
    if (op.guildId !== interaction.guildId) continue;
    const history = Array.isArray(op.reviewHistory) && op.reviewHistory.length
      ? op.reviewHistory
      : (op.reviewedBy ? [{ action: op.status, userId: op.reviewedBy, at: op.reviewedAt || 0 }] : []);
    for (const action of history) {
      const time = action.at || 0;
      if (!action.userId || time < range.start.getTime() || time > range.end.getTime()) continue;
      const row = stats.get(action.userId) || { approved: 0, rejected: 0, correction: 0 };
      if (action.action === "approved") row.approved += 1;
      else if (action.action === "rejected") row.rejected += 1;
      else if (action.action === "correction") row.correction += 1;
      stats.set(action.userId, row);
    }
  }

  const rows = [...stats.entries()]
    .map(([userId, x]) => ({ userId, ...x, total: x.approved + x.rejected + x.correction }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  const description = rows.length
    ? rows.map((x, i) => `**${i + 1}.** <@${x.userId}> — **${x.total}** تمت معالجته\n└ ✅ ${x.approved} • ❌ ${x.rejected} • 🟠 ${x.correction}`).join("\n\n")
    : "لا توجد مراجعات مسجلة هذا الأسبوع.";

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("👮 إحصائيات المراجعين — هذا الأسبوع").setDescription(description).setTimestamp()],
    flags: MessageFlags.Ephemeral,
  });
  scheduleEphemeralDelete(interaction);
}

function getStatusText(operation) {
  if (operation.status === "pending") return "🟠 بانتظار المراجعة";
  if (operation.status === "approved") return operation.reviewedBy ? `✅ تم القبول بواسطة <@${operation.reviewedBy}>` : "✅ مقبول";
  if (operation.status === "rejected") return operation.reviewedBy ? `❌ تم الرفض بواسطة <@${operation.reviewedBy}>` : "❌ مرفوض";
  if (operation.status === "correction") return operation.reviewedBy ? `🟠 تم طلب التصحيح بواسطة <@${operation.reviewedBy}>` : "🟠 التصحيح المطلوب";
  return "🟡 قيد الإعداد";
}

function createOperationId() {
  let highest = 0;
  for (const id of operations.keys()) {
    const match = /^OP-(\d+)$/.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  let next = highest + 1;
  let id = `OP-${String(next).padStart(4, "0")}`;
  while (operations.has(id)) {
    next += 1;
    id = `OP-${String(next).padStart(4, "0")}`;
  }
  return id;
}

function getCategoryColor(key) {
  if (key === "minor") return 0x57f287;
  if (key === "medium") return 0xfee75c;
  if (key === "major") return 0xed4245;
  return 0x2b2d31;
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("fr-FR");
}

function isConfiguredId(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

function isValidImage(attachment) {
  const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp"];
  const allowedContentTypes = ["image/jpeg", "image/png", "image/webp"];
  const name = attachment.name?.toLowerCase() || "";
  const contentType = attachment.contentType?.toLowerCase() || "";

  // Discord peut parfois ne pas fournir contentType.
  // On accepte donc une extension valide OU un type MIME d’image valide.
  return (
    allowedExtensions.some((extension) => name.endsWith(extension)) ||
    allowedContentTypes.includes(contentType)
  );
}

async function bootstrap() {
  try {
    httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.log(`🌐 Serveur HTTP actif sur le port ${PORT}`);
    });

    await storage.initializeStorage();
    weeklyReports = await loadWeeklyReports();
    officerResets = await loadOfficerResets();
    await loadOperations();
    await client.login(TOKEN);
  } catch (error) {
    console.error("❌ Impossible de démarrer le bot.", error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\n🛑 Arrêt demandé (${signal})...`);
  client.destroy();
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await storage.closeStorage().catch(() => {});
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

bootstrap();
