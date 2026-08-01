require("dotenv").config();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}



const operationTypes = {
  house: { name: "منزل", emoji: "🏠", categoryKey: "minor" },
  atm: { name: "صراف آلي", emoji: "🏧", categoryKey: "minor" },
  store: { name: "متجر", emoji: "🏪", categoryKey: "minor" },
  drug_sell: { name: "بيع مخدرات", emoji: "💊", categoryKey: "minor" },
  shot_fire: { name: "إطلاق نار", emoji: "🔫", categoryKey: "minor" },

  fleeca: { name: "بنك فليكا", emoji: "🏦", categoryKey: "medium" },
  bijoux: { name: "محل مجوهرات", emoji: "💎", categoryKey: "medium" },
  paleto_ammunation: { name: "أمونيشن باليتو", emoji: "🔫", categoryKey: "medium" },

  yacht: { name: "يخت", emoji: "🛥️", categoryKey: "major" },
  cargo_ship: { name: "سفينة شحن", emoji: "🚢", categoryKey: "major" },
  labo: { name: "مختبر", emoji: "🧪", categoryKey: "major" },
  pacific_bank: { name: "بنك باسيفيك", emoji: "🏛️", categoryKey: "major" },
  post_bank: { name: "بنك البريد", emoji: "🏤", categoryKey: "major" },
  submarine: { name: "غواصة", emoji: "🚇", categoryKey: "major" },
  train: { name: "قطار", emoji: "🚂", categoryKey: "major" },
};

module.exports = {
  operationsChannelId: process.env.OPERATIONS_CHANNEL_ID || "",
  statsChannelId: process.env.STATS_CHANNEL_ID || "",
  logsChannelId: process.env.LOGS_CHANNEL_ID || "",
  reportTimezone: process.env.REPORT_TIMEZONE || "Europe/Brussels",
  supervisorRoleId: process.env.SUPERVISOR_ROLE_ID || "",
  policeRoleId: process.env.POLICE_ROLE_ID || "",

  operationTypes,

  rewards: {
    minor: {
      name: "عملية صغرى",
      emoji: "🟢",
      leaderBonus: numberFromEnv("MINOR_LEADER", 4000),
      memberBonus: numberFromEnv("MINOR_MEMBER", 3000),
    },
    medium: {
      name: "عملية متوسطة",
      emoji: "🟡",
      leaderBonus: numberFromEnv("MEDIUM_LEADER", 9000),
      memberBonus: numberFromEnv("MEDIUM_MEMBER", 7000),
    },
    major: {
      name: "عملية كبرى",
      emoji: "🔴",
      leaderBonus: numberFromEnv("MAJOR_LEADER", 15000),
      memberBonus: numberFromEnv("MAJOR_MEMBER", 12000),
    },
  },
};
