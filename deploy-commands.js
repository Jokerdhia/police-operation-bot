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
    .setDescription("Créer un nouveau rapport d'opération de police"),

  new SlashCommandBuilder()
    .setName("prime")
    .setDescription("Afficher ta prime hebdomadaire ou celle d'un policier")
    .addUserOption((option) =>
      option
        .setName("policier")
        .setDescription("Policier à consulter — laisse vide pour voir ta prime")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("classement")
    .setDescription("Afficher le Top 10 hebdomadaire des policiers"),

  new SlashCommandBuilder()
    .setName("controleurs")
    .setDescription("Afficher les statistiques hebdomadaires des contrôleurs"),

  new SlashCommandBuilder()
    .setName("rapport-semaine")
    .setDescription("Publier un rapport hebdomadaire des opérations")
    .addStringOption((option) =>
      option
        .setName("periode")
        .setDescription("Choisir la semaine à afficher")
        .setRequired(false)
        .addChoices(
          { name: "Semaine actuelle", value: "current" },
          { name: "Semaine précédente", value: "previous" }
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

    console.log("✅ Commandes installées avec succès.");
  } catch (error) {
    console.error("❌ Erreur pendant l'installation des commandes :", error);
    process.exit(1);
  }
}

deployCommands();
