require("dotenv").config();

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ TOKEN, CLIENT_ID ou GUILD_ID manque dans le fichier .env.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("operation")
    .setDescription("إنشاء تقرير جديد لعملية شرطة"),

  new SlashCommandBuilder()
    .setName("prime")
    .setDescription("عرض مكافأتك الأسبوعية أو مكافأة شرطي آخر")
    .addUserOption((option) =>
      option
        .setName("policier")
        .setDescription("اختر الشرطي — اتركه فارغاً لعرض مكافأتك")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("classement")
    .setDescription("عرض أفضل 10 أفراد شرطة أسبوعياً"),

  new SlashCommandBuilder()
    .setName("controleurs")
    .setDescription("عرض الإحصائيات الأسبوعية للمراجعين"),

  new SlashCommandBuilder()
    .setName("rapport-semaine")
    .setDescription("نشر التقرير الأسبوعي للعمليات")
    .addStringOption((option) =>
      option
        .setName("periode")
        .setDescription("اختر الأسبوع المراد عرضه")
        .setRequired(false)
        .addChoices(
          { name: "الأسبوع الحالي", value: "current" },
          { name: "الأسبوع السابق", value: "previous" }
        )
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function deployCommands() {
  try {
    console.log("⏳ Installation des commandes /operation, /prime, /classement, /controleurs et /rapport-semaine...");

    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });

    console.log("✅ تم تثبيت الأوامر بنجاح.");
  } catch (error) {
    console.error("❌ Erreur pendant l'installation des commandes :", error);
    process.exit(1);
  }
}

deployCommands();
