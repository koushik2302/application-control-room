import fs from "fs";
import path from "path";
import { baseDir } from "./paths.js";

export const DATA_DIR = process.env.ACR_DATA_DIR || path.join(baseDir, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");

const empty = {
  profile: {
    name: "",
    email: "",
    phone: "",
    location: "",
    linkedin: "",
    github: "",
    portfolio: "",
    summary: "",
    education: "",
    experience: "",
    projects: "",
    skills: "",
  },
  tickets: [],
  watchlist: [],
  runLog: [],
};

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2));
    return structuredClone(empty);
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return { ...structuredClone(empty), ...JSON.parse(raw) };
  } catch (e) {
    console.error("Failed to read data.json, starting fresh:", e.message);
    return structuredClone(empty);
  }
}

let data = load();

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

export function getData() {
  return data;
}

export function setProfile(profile) {
  data.profile = profile;
  save();
  return data.profile;
}

export function setTickets(tickets) {
  data.tickets = tickets;
  save();
  return data.tickets;
}

export function setWatchlist(watchlist) {
  data.watchlist = watchlist;
  save();
  return data.watchlist;
}

export function appendRunLog(entry) {
  data.runLog = [entry, ...data.runLog].slice(0, 100);
  save();
  return data.runLog;
}

// Based on the highest existing ticket number, not array length — length
// undercounts once any ticket has ever been deleted, which previously caused
// new tickets to collide with (and overwrite) an existing id.
export function nextTicketId(tickets) {
  const max = tickets.reduce((m, t) => {
    const n = Number(String(t.id || "").replace("APP-", ""));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `APP-${String(max + 1).padStart(3, "0")}`;
}
