'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

export const AI_PROVIDER_CLAUDE = 0;
export const AI_PROVIDER_GEMINI = 1;

export class AiProvider {
  constructor() {
    this._session = new Soup.Session();
    this._session.timeout = 60;
  }

  query(options, callback) {
    let { provider, apiKey, messages, contextFiles, maxContextKb } = options;
    let workingMessages = messages.slice();

    if (contextFiles && contextFiles.length > 0) {
      let contextText = this._buildContext(contextFiles, maxContextKb || 32);
      if (contextText && workingMessages.length > 0) {
        let last = workingMessages[workingMessages.length - 1];
        workingMessages[workingMessages.length - 1] = {
          role: last.role,
          content: `Context:\n${contextText}\n\n---\n\n${last.content}`,
        };
      }
    }

    if (provider === AI_PROVIDER_GEMINI)
      this._queryGemini(apiKey, workingMessages, callback);
    else
      this._queryClaude(apiKey, workingMessages, callback);
  }

  _buildContext(files, maxKb) {
    let parts = [];
    let totalBytes = 0;
    let maxBytes = maxKb * 1024;
    let allFiles = [...files];

    for (let i = 0; i < allFiles.length; i++) {
      let filePath = allFiles[i];
      try {
        let file = Gio.File.new_for_path(filePath);
        let info = file.query_info('standard::type,standard::content-type', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
          this._collectDirFiles(filePath).forEach(f => allFiles.push(f));
          continue;
        }
        let [, contents] = file.load_contents(null);
        let text = new TextDecoder().decode(contents);
        if (totalBytes + text.length > maxBytes)
          text = text.slice(0, maxBytes - totalBytes);
        parts.push(`=== ${filePath} ===\n${text}`);
        totalBytes += text.length;
        if (totalBytes >= maxBytes)
          break;
      } catch (_e) {
        // skip unreadable files
      }
    }
    return parts.join('\n\n');
  }

  _collectDirFiles(dirPath) {
    let result = [];
    try {
      let dir = Gio.File.new_for_path(dirPath);
      let enumerator = dir.enumerate_children(
        'standard::name,standard::type,standard::content-type',
        Gio.FileQueryInfoFlags.NONE, null
      );
      let info;
      while ((info = enumerator.next_file(null)) !== null) {
        if (info.get_file_type() === Gio.FileType.REGULAR) {
          let mime = info.get_content_type() || '';
          if (mime.startsWith('text/') || mime === 'application/json')
            result.push(GLib.build_filenamev([dirPath, info.get_name()]));
        }
      }
      enumerator.close(null);
    } catch (_e) {
      // ignore
    }
    return result;
  }

  _queryClaude(apiKey, messages, callback) {
    let url = 'https://api.anthropic.com/v1/messages';
    let body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    let message = Soup.Message.new('POST', url);
    message.request_headers.append('x-api-key', apiKey);
    message.request_headers.append('anthropic-version', '2023-06-01');
    let bytes = GLib.Bytes.new(new TextEncoder().encode(body));
    message.set_request_body_from_bytes('application/json', bytes);

    this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_obj, result) => {
      try {
        let respBytes = this._session.send_and_read_finish(result);
        let text = new TextDecoder().decode(respBytes.get_data());
        let data = JSON.parse(text);
        if (data.content && data.content[0])
          callback(null, data.content[0].text);
        else if (data.error)
          callback(data.error.message, null);
        else
          callback('Unknown error from Claude API', null);
      } catch (e) {
        callback(e.message, null);
      }
    });
  }

  _queryGemini(apiKey, messages, callback) {
    let url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    let contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    let body = JSON.stringify({ contents });

    let message = Soup.Message.new('POST', url);
    let bytes = GLib.Bytes.new(new TextEncoder().encode(body));
    message.set_request_body_from_bytes('application/json', bytes);

    this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_obj, result) => {
      try {
        let respBytes = this._session.send_and_read_finish(result);
        let text = new TextDecoder().decode(respBytes.get_data());
        let data = JSON.parse(text);
        let candidate = data.candidates &&
          data.candidates[0] &&
          data.candidates[0].content &&
          data.candidates[0].content.parts &&
          data.candidates[0].content.parts[0] &&
          data.candidates[0].content.parts[0].text;
        if (candidate)
          callback(null, candidate);
        else if (data.error)
          callback(data.error.message, null);
        else
          callback('Unknown error from Gemini API', null);
      } catch (e) {
        callback(e.message, null);
      }
    });
  }

  destroy() {
    // Soup.Session is GC-managed
  }
}
