'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'search-light']);
const SEARCH_HISTORY_FILE = GLib.build_filenamev([DATA_DIR, 'search-history.json']);
const AI_HISTORY_DIR = GLib.build_filenamev([DATA_DIR, 'ai-history']);

function ensureDir(path) {
  GLib.mkdir_with_parents(path, 0o755);
}

function readJsonFile(path) {
  try {
    let file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
      return null;
    let [, contents] = file.load_contents(null);
    return JSON.parse(new TextDecoder().decode(contents));
  } catch (_e) {
    return null;
  }
}

function writeJsonFile(path, data) {
  try {
    let file = Gio.File.new_for_path(path);
    let encoded = new TextEncoder().encode(JSON.stringify(data, null, 2));
    file.replace_contents(encoded, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
  } catch (_e) {
    // ignore write errors silently
  }
}

export class SearchHistory {
  constructor(maxEntries) {
    this._maxEntries = maxEntries || 100;
    this._entries = [];
    this._load();
  }

  _load() {
    let data = readJsonFile(SEARCH_HISTORY_FILE);
    this._entries = Array.isArray(data) ? data : [];
  }

  add(query) {
    if (!query || !query.trim())
      return;
    let q = query.trim();
    this._entries = this._entries.filter(e => e.query !== q);
    this._entries.unshift({ query: q, timestamp: Date.now() });
    if (this._entries.length > this._maxEntries)
      this._entries = this._entries.slice(0, this._maxEntries);
    this._save();
  }

  get entries() {
    return this._entries.slice();
  }

  clear() {
    this._entries = [];
    this._save();
  }

  _save() {
    try {
      ensureDir(DATA_DIR);
      writeJsonFile(SEARCH_HISTORY_FILE, this._entries);
    } catch (_e) {
      // ignore
    }
  }
}

export class AiHistory {
  constructor(maxConversations) {
    this._maxConversations = maxConversations || 50;
  }

  newId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  saveConversation(id, messages) {
    try {
      ensureDir(AI_HISTORY_DIR);
      let path = GLib.build_filenamev([AI_HISTORY_DIR, `${id}.json`]);
      writeJsonFile(path, { id, messages, timestamp: Date.now() });
      this._prune();
    } catch (_e) {
      // ignore
    }
  }

  loadConversation(id) {
    let path = GLib.build_filenamev([AI_HISTORY_DIR, `${id}.json`]);
    return readJsonFile(path);
  }

  listConversations() {
    try {
      ensureDir(AI_HISTORY_DIR);
      let dir = Gio.File.new_for_path(AI_HISTORY_DIR);
      let enumerator = dir.enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null
      );
      let conversations = [];
      let info;
      while ((info = enumerator.next_file(null)) !== null) {
        let name = info.get_name();
        if (!name.endsWith('.json'))
          continue;
        let convId = name.slice(0, -5);
        let data = this.loadConversation(convId);
        if (data) {
          let preview = '';
          let first = data.messages.find(m => m.role === 'user');
          if (first)
            preview = first.content.slice(0, 60);
          conversations.push({ id: data.id, timestamp: data.timestamp, preview });
        }
      }
      enumerator.close(null);
      return conversations.sort((a, b) => b.timestamp - a.timestamp);
    } catch (_e) {
      return [];
    }
  }

  _prune() {
    let conversations = this.listConversations();
    if (conversations.length <= this._maxConversations)
      return;
    conversations.slice(this._maxConversations).forEach(c => {
      try {
        let path = GLib.build_filenamev([AI_HISTORY_DIR, `${c.id}.json`]);
        Gio.File.new_for_path(path).delete(null);
      } catch (_e) {
        // ignore
      }
    });
  }
}
