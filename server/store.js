import fs from "fs";
import path from "path";
import { baseDir } from "./paths.js";

const DATA_DIR = process.env.ACR_DATA_DIR || path.join(baseDir, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");

const empty = {
  profile: { name: "", summary: "", experience: "", projects: "", skills: "" },
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
