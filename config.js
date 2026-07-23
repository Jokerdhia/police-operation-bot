require("dotenv").config();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}



const operationTypes = {
  house: { name: "House", emoji: "🏠", categoryKey: "minor" },
  atm: { name: "ATM", emoji: "🏧", categoryKey: "minor" },
  store: { name: "Store", emoji: "🏪", categoryKey: "minor" },
  drug_sell: { name: "Drug Sell", emoji: "💊", categoryKey: "minor" },
  shot_fire: { name: "Shot Fire", emoji: "🔫", categoryKey: "minor" },

  fleeca: { name: "Fleeca", emoji: "🏦", categoryKey: "medium" },
  bijoux: { name: "Bijoux", emoji: "💎", categoryKey: "medium" },
  paleto_ammunation: { name: "Paleto Ammu-Nation", emoji: "🔫", categoryKey: "medium" },

  yacht: { name: "Yacht", emoji: "🛥️", categoryKey: "major" },
  cargo_ship: { name: "Cargo Ship", emoji: "🚢", categoryKey: "major" },
  labo: { name: "Laboratoire", emoji: "🧪", categoryKey: "major" },
  pacific_bank: { name: "Pacific Bank", emoji: "🏛️", categoryKey: "major" },
  post_bank: { name: "Post Bank", emoji: "🏤", categoryKey: "major" },
  submarine: { name: "Submarine", emoji: "🚇", categoryKey: "major" },
  train: { name: "Train", emoji: "🚂", categoryKey: "major" },
};

module.exports = {
  operationsChannelId: process.env.OPERATIONS_CHANNEL_ID || "",
  statsChannelId: process.env.STATS_CHANNEL_ID || "",
  reportTimezone: process.env.REPORT_TIMEZONE || "Europe/Brussels",
  supervisorRoleId: process.env.SUPERVISOR_ROLE_ID || "",
  policeRoleId: process.env.POLICE_ROLE_ID || "",

  operationTypes,

  rewards: {
    minor: {
      name: "Opération mineure",
      emoji: "🟢",
      leaderBonus: numberFromEnv("MINOR_LEADER", 4000),
      memberBonus: numberFromEnv("MINOR_MEMBER", 3000),
    },
    medium: {
      name: "Opération moyenne",
      emoji: "🟡",
      leaderBonus: numberFromEnv("MEDIUM_LEADER", 9000),
      memberBonus: numberFromEnv("MEDIUM_MEMBER", 7000),
    },
    major: {
      name: "Grande opération",
      emoji: "🔴",
      leaderBonus: numberFromEnv("MAJOR_LEADER", 15000),
      memberBonus: numberFromEnv("MAJOR_MEMBER", 12000),
    },
  },
};
