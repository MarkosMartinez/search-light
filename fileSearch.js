'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class FileSearch {
  constructor() {
    this._proc = null;
    this._debounceId = null;
  }

  search(query, options, callback) {
    if (this._debounceId) {
      GLib.source_remove(this._debounceId);
      this._debounceId = null;
    }
    this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      this._debounceId = null;
      this._doSearch(query, options, callback);
      return GLib.SOURCE_REMOVE;
    });
  }

  _doSearch(query, options, callback) {
    this._cancel();
    if (!query || query.length < 2) {
      callback([]);
      return;
    }
    let root = options.root || '~';
    if (root === '~' || root.startsWith('~/'))
      root = `${GLib.get_home_dir()}${root.slice(1)}`;
    let maxResults = options.maxResults || 50;
    let useLocate = options.useLocate !== false;

    if (useLocate) {
      this._runLocate(query, maxResults, results => {
        if (results !== null)
          callback(results);
        else
          this._runGrep(query, root, maxResults, callback);
      });
    } else {
      this._runGrep(query, root, maxResults, callback);
    }
  }

  _runLocate(query, maxResults, callback) {
    try {
      let proc = Gio.Subprocess.new(
        ['locate', '-i', '-l', String(maxResults), query],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
      );
      this._proc = proc;
      proc.communicate_utf8_async(null, null, (_proc, res) => {
        try {
          let [, stdout] = _proc.communicate_utf8_finish(res);
          if (_proc.get_exit_status() === 0 && stdout && stdout.trim()) {
            let results = stdout.trim().split('\n')
              .filter(l => l.trim())
              .slice(0, maxResults);
            callback(results);
          } else {
            callback(null);
          }
        } catch (_e) {
          callback(null);
        }
        if (this._proc === _proc)
          this._proc = null;
      });
    } catch (_e) {
      callback(null);
    }
  }

  _runGrep(query, root, maxResults, callback) {
    try {
      let proc = Gio.Subprocess.new(
        ['grep', '-rl', '--', query, root],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
      );
      this._proc = proc;
      let killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
        try { proc.force_exit(); } catch (_e) {}
        return GLib.SOURCE_REMOVE;
      });
      proc.communicate_utf8_async(null, null, (_proc, res) => {
        GLib.source_remove(killTimer);
        try {
          let [, stdout] = _proc.communicate_utf8_finish(res);
          let results = stdout
            ? stdout.trim().split('\n').filter(l => l.trim()).slice(0, maxResults)
            : [];
          callback(results);
        } catch (_e) {
          callback([]);
        }
        if (this._proc === _proc)
          this._proc = null;
      });
    } catch (_e) {
      callback([]);
    }
  }

  _cancel() {
    if (this._proc) {
      try { this._proc.force_exit(); } catch (_e) {}
      this._proc = null;
    }
  }

  destroy() {
    if (this._debounceId) {
      GLib.source_remove(this._debounceId);
      this._debounceId = null;
    }
    this._cancel();
  }
}
