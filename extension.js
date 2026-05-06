/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { trySpawnCommandLine } from 'resource:///org/gnome/shell/misc/util.js';

import { Timer } from './timer.js';
import { Style } from './style.js';

import { TintEffect } from './effects/tint_effect.js';
import { MonochromeEffect } from './effects/monochrome_effect.js';
import { BlurEffect } from './effects/blur_effect.js';

import { schemaId, SettingsKeys } from './preferences/keys.js';
import { KeyboardShortcuts } from './keybinding.js';
import { FileSearch } from './fileSearch.js';
import { AiProvider } from './aiProvider.js';
import { SearchHistory, AiHistory } from './history.js';

import {
  Extension,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

var SearchLight = GObject.registerClass(
  {},
  class SearchLight extends St.Widget {
    _init() {
      super._init();
      this.name = 'searchLight';
      this.offscreen_redirect = Clutter.OffscreenRedirect.ALWAYS;
      this.layout_manager = new Clutter.BinLayout();
    }
  },
);

export default class SearchLightExt extends Extension {
  enable() {
    this._style = new Style();

    this._hiTimer = new Timer('hi-res timer');
    this._hiTimer.initialize(15);

    // for deferred or debounced runs
    this._loTimer = new Timer('lo-res timer');
    this._loTimer.initialize(750);

    this._settings = this.getSettings(schemaId);
    this._settingsKeys = SettingsKeys();

    this._settingsKeys.connectSettings(this._settings, (name, value) => {
      let n = name.replace(/-/g, '_');
      this[n] = value;
      switch (name) {
        case 'show-panel-icon':
          if (this._indicator) {
            this._indicator.visible = value;
          }
          break;
        case 'background-color':
        case 'blur-background':
        case 'panel-icon-color':
          this._updateBlurredBackground();
          this._updateCss();
          break;
        case 'use-animations':
          this._useAnimations = value;
          break;
        case 'animation-speed':
          this._animationSpeed = value;
          break;
        case 'border-radius':
          break;
        case 'shortcut-search':
          this._updateShortcut();
          break;
        case 'secondary-shortcut-search':
          this._updateShortcut2();
          break;
        case 'window-effect': {
          this._updateWindowEffect();
          break;
        }
        case 'window-effect-color': {
          if (this.windowEffect) {
            this.windowEffect.color = this.window_effect_color;
          }
          break;
        }
      }
    });
    Object.keys(this._settingsKeys._keys).forEach((k) => {
      let key = this._settingsKeys.getKey(k);
      let name = k.replace(/-/g, '_');
      this[name] = key.value;
      if (key.options) {
        this[`${name}_options`] = key.options;
      }
      // console.log(`${name} ${key.value}`);
    });

    this._desktopSettings = new Gio.Settings({
      schema_id: 'org.gnome.desktop.background',
    });
    this._desktopSettings.connectObject(
      'changed::picture-uri',
      () => {
        this._updateBlurredBackground();
      },
      this,
    );

    this.mainContainer = new SearchLight();
    this.mainContainer._delegate = this;
    this.container = new St.BoxLayout({
      name: 'searchLightBox',
      orientation: Clutter.Orientation.VERTICAL,
      reactive: true,
      track_hover: true,
      can_focus: true,
    });

    this.hide();
    this.container._delegate = this;

    Main.layoutManager.addChrome(this.mainContainer, {
      affectsStruts: false,
      trackFullscreen: false,
    });

    this.mainContainer.add_child(this.container);

    this._setupBackground();

    this.accel = new KeyboardShortcuts();
    this.accel.enable();
    this.accel2 = new KeyboardShortcuts();
    this.accel2.enable();

    this._updateShortcut();
    this._updateShortcut2();
    this._updateCss();

    this._useAnimations = this._settings.get_boolean('use-animations');
    this._animationSpeed = this._settings.get_double('animation-speed');

    Main.overview.connectObject(
      'showing',
      this._onOverviewShowing.bind(this),
      'hidden',
      this._onOverviewHidden.bind(this),
      this,
    );

    Shell.AppSystem.get_default().connectObject(
      'app-state-changed',
      this._onAppStateChanged.bind(this),
      this,
    );

    global.display.connectObject(
      'window-created',
      () => {
        if (this._visible) {
          this.mainContainer.opacity = 0;
        }
      },
      this,
    );

    this._loTimer.runOnce(() => {
      // this.show();
    }, 500);

    Main.overview.searchLight = this;

    let _providers = [];

    // deferred startup for providers
    let idx = 0;
    _providers.forEach((p) => {
      this._loTimer.runOnce(() => {
        p.initialize();
      }, idx * 5000);
    });

    this._loTimer.runOnce(() => {
      this._createIndicator();
    }, 1500);
    this._updateProviders();
    this._updateWindowEffect();
    this._updateBlurredBackground();
    this._initServices();
  }

  disable() {
    this._hiTimer?.shutdown();
    this._loTimer?.shutdown();
    this._hiTimer = null;
    this._loTimer = null;

    if (this._indicator) {
      this._indicator.disconnectObject(this);
      if (this._indicator.get_parent()) {
        this._indicator.get_parent().remove_child(this._indicator);
      }
      this._indicator = null;
    }

    this._style.unloadAll();
    this._style = null;

    this._settingsKeys.disconnectSettings();
    this._settings = null;

    this._desktopSettings.disconnectObject();
    this._desktopSettings = null;

    if (this.accel) {
      this.accel.disable();
      delete this.accel;
      this.accel = null;
    }
    if (this.accel2) {
      this.accel2.disable();
      delete this.accel2;
      this.accel2 = null;
    }

    this._removeProviders();
    this._providers = null;

    if (this._fileSearch) {
      this._fileSearch.destroy();
      this._fileSearch = null;
    }
    if (this._aiProvider) {
      this._aiProvider.destroy();
      this._aiProvider = null;
    }
    this._searchHistory = null;
    this._aiHistory = null;
    this._aiMessages = [];

    if (this._background) {
      if (this._background.get_parent()) {
        this._background.get_parent().remove_child(this._background);
      }
      this._background = null;
    }

    Main.layoutManager.removeChrome(this.mainContainer);
    this.mainContainer = null;
  }

  _createIndicator() {
    if (this._indicator) return;
    this._indicator = new St.Button({
      style_class: 'panel-status-indicators-box',
    });
    let icon = new St.Icon({
      style_class: 'panel-status-indicator-icon',
      gicon: new Gio.ThemedIcon({ name: 'search-symbolic' }),
    });
    icon.style = 'margin-top: 6px !important; margin-bottom: 6px !important;';
    this._indicator.set_child(icon);
    this._indicator.connectObject(
      'button-press-event',
      this._toggle_search_light.bind(this),
      this,
    );
    try {
      Main.panel._rightBox.insert_child_at_index(this._indicator, 0);
      this._indicator.visible = this.show_panel_icon;
    } catch (err) {
      logError(err);
    }
  }

  _createEffect(idx) {
    let effect = null;
    switch (idx) {
      case 1: {
        effect = new TintEffect({
          name: 'color',
          color: this.window_effect_color,
        });
        effect.preload(this.path);
        break;
      }
      case 2: {
        effect = new MonochromeEffect({
          name: 'color',
          color: this.window_effect_color,
        });
        effect.preload(this.path);
        break;
      }
      case 3: {
        effect = new BlurEffect({
          name: 'color',
          color: this.window_effect_color,
        });
        effect.preload(this.path);
        break;
      }
    }
    return effect;
  }

  _updateBlurredBackground() {
    this.desktop_background = this._desktopSettings.get_string('picture-uri');

    let uuid = GLib.get_user_name();
    this.desktop_background_blurred = `/tmp/searchlight-${uuid}-bg-blurred.jpg`;

    if (this.blur_background) {
      //   let color = this.background_color || [0, 0, 0, 0.5];
      //   let bg = this._desktopSettings.get_string('picture-uri');
      //   let a = Math.floor(100 - color[3] * 100);
      //   let rgb = this._style.hex(color);
      //   let cmd = `convert -scale 10% -blur 0x2.5 -resize 200% -fill "${rgb}" -tint ${a} "${bg}" ${this.desktop_background_blurred}`;
      let cmd = `convert -scale 10% -blur 0x2.5 -resize 200% "${this.desktop_background}" ${this.desktop_background_blurred}`;
      log(cmd);
      trySpawnCommandLine(cmd);
    }
  }

  _updateWindowEffect() {
    // this.window_effect = 2;
    // this.window_effect_color = [1, 0, 0, 0.5];
    this.container.remove_effect_by_name('window-effect');
    let effect = this._createEffect(this.window_effect);
    if (effect) {
      this.container.add_effect_with_name('window-effect', effect);
    }
    this.windowEffect = effect;
  }

  _updatePanelIcon(_disable) {}

  _updateProviders() {
    this._removeProviders();
    this._providers = [];

    let _search = Main.overview.searchController;
    if (!_search) return;

    // add providers here

    if (_search.addProvider) {
      this._providers.forEach((p) => {
        _search.addProvider(p);
      });
    }
  }

  _removeProviders() {
    if (!this._providers) {
      return;
    }

    let _search = Main.overview.searchController;
    if (!_search) return;

    if (_search.removeProvider) {
      this._providers.forEach((p) => {
        _search.removeProvider(p);
      });
    }

    this._providers = null;
  }

  _setupBackground() {
    if (this._background && this._background.get_parent()) {
      this._background.get_parent().remove_child(this._background);
    }

    // blurred background image
    // this._bgActor = new Meta.BackgroundActor();
    // let bgSource = Main.layoutManager._backgroundGroup.get_child_at_index(0);
    // this._bgActor.set_content(bgSource.get_content());
    // this._blurEffect = new Shell.BlurEffect({
    //   name: 'blur',
    //   brightness: this.blur_brightness,
    //   sigma: this.blur_sigma,
    //   mode: Shell.BlurMode.ACTOR,
    // });

    if (!this._blurEffect) {
      this._blurEffect = this._createEffect(1);
    }

    let background = new St.Widget({
      name: 'searchLightBlurredBackground',
      layout_manager: new Clutter.BinLayout(),
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    });

    // let image = new St.Widget({
    //   name: 'searchLightBlurredBackgroundImage',
    //   x: 0,
    //   y: 0,
    //   width: 20,
    //   height: 20,
    //   effect: this._blurEffect,
    // });

    // image.add_child(this._bgActor);
    // background.add_child(image);
    // this._bgActor.clip_to_allocation = true;
    // this._bgActor.offscreen_redirect = Clutter.OffscreenRedirect.ALWAYS;

    this.mainContainer.insert_child_below(background, this.container);
    this._background = background;
    this._background.opacity = 0;
    this._background.visible = false;
  }

  show() {
    if (Main.overview.visible) return;

    if (this._animSeq) {
      this._hiTimer.cancel(this._animSeq);
      this._animSeq = null;
    }
    this._acquire_ui();

    if (this._bgActor) {
      let bgSource = Main.layoutManager._backgroundGroup.get_child_at_index(0);
      this._bgActor.set_content(bgSource.get_content());
    }

    this._updateCss();
    this._layout();

    global.compositor.disable_unredirect();

    this.mainContainer.show();
    this.container.show();
    this._add_events();

    // fixes the background size relative to text - after adjusting font size
    this._animSeq = this._hiTimer.runOnce(() => {
      this._animSeq = null;
      this._layout();
      // animate after adjust so width+height are correct
      if (this._useAnimations) {
        this.mainContainer.opacity = 0;
        this.mainContainer.scale_x = 0.9;
        this.mainContainer.scale_y = 0.9;
        this.mainContainer.translation_x = (this.width * 0.1) / 2;
        this.mainContainer.translation_y = (this.height * 0.1) / 2;
        this.mainContainer.ease({
          opacity: 255,
          scale_x: 1.0,
          scale_y: 1.0,
          translation_x: 0,
          translation_y: 0,
          duration: this._animationSpeed,
          mode: Clutter.AnimationMode.EASE_OUT,
        });
      } else {
        this.mainContainer.scale_x = 1.0;
        this.mainContainer.scale_y = 1.0;
        this.mainContainer.opacity = 255;
      }
    }, 100);
  }

  hide() {
    if (this._isDraggingIcon()) {
      return;
    }

    this._release_ui();
    this._remove_events();

    if (this._useAnimations) {
      this.mainContainer.ease({
        opacity: 0,
        scale_x: 0.9,
        scale_y: 0.9,
        translation_x: (this.width * 0.1) / 2,
        translation_y: (this.height * 0.1) / 2,
        duration: this._animationSpeed,
        mode: Clutter.AnimationMode.EASE_OUT,
        onComplete: () => {
          this._visible = false;
          this.mainContainer.hide();
          global.compositor.enable_unredirect();
        },
      });
    } else {
      this.mainContainer.opacity = 0;
      this._visible = false;
      this.mainContainer.hide();
      global.compositor.enable_unredirect();
    }
    // this._hidePopups();
  }

  _findGridSearchResults(actor) {
    if (!actor) {
      return null;
    }
    if (actor.style_class === 'grid-search-results') {
      return actor;
    }
    let c = actor.get_first_child();
    while (c) {
      let found = this._findGridSearchResults(c);
      if (found) {
        return found;
      }
      c = c.get_next_sibling();
    }
    return null;
  }

  _actorHasActiveDrag(actor, depth) {
    if (!actor || depth < 0) {
      return false;
    }
    if (
      actor._draggable &&
      actor._draggable._dragState === 1 /* DragState.DRAGGING */
    ) {
      return true;
    }
    let c = actor.get_first_child();
    while (c) {
      if (this._actorHasActiveDrag(c, depth - 1)) {
        return true;
      }
      c = c.get_next_sibling();
    }
    return false;
  }

  _isDraggingIcon() {
    try {
      if (!this._searchResults) {
        return false;
      }
      let grid = this._findGridSearchResults(this._searchResults);
      if (!grid) {
        return false;
      }
      let c = grid.get_first_child();
      while (c) {
        if (c.visible && this._actorHasActiveDrag(c, 4)) {
          return true;
        }
        c = c.get_next_sibling();
      }
    } catch (err) {
      logError(err);
    }
    return false;
  }

  _layout() {
    this._queryDisplay();
    if (!this.monitor) return;

    // container size
    this.width =
      600 + ((this.sw * this.scaleFactor) / 2) * (this.scale_width || 0);
    this.height =
      400 + ((this.sh * this.scaleFactor) / 2) * (this.scale_height || 0);

    this.initial_height = this._entry.height + 4 * this.scaleFactor;

    // position
    let x = this.monitor.x + this.sw / 2 - this.width / 2;
    let y = this.monitor.y + this.sh / 2 - this.height / 2;
    this._visible = true;

    this.container.set_size(this.width, this.initial_height);
    this.mainContainer.set_size(this.width, this.initial_height);
    this.mainContainer.set_position(x, y);

    // background
    if (this._background) {
      if (this._bgActor) {
        this._bgActor.set_position(this.monitor.x - x, this.monitor.y - y);
        this._bgActor.set_size(this.monitor.width, this.monitor.height);
        this._bgActor
          .get_parent()
          .set_size(this.monitor.width, this.monitor.height);
      }
      let padding = 0; //this.border_thickness || 0;
      this._background.set_position(padding, padding);
      this._background.set_size(
        this.monitor.width - padding * 2,
        this.monitor.height - padding * 2,
      );
    }
  }

  _updateShortcut(disable) {
    this.accel.unlisten();

    let shortcut = '';
    try {
      shortcut = (this.shortcut_search || []).join('');
    } catch (err) {
      //
    }
    if (shortcut === '') {
      shortcut = '<Control><Super>Space';
    }

    if (!disable) {
      this.accel.listenFor(shortcut, this._toggle_search_light.bind(this));
    }
  }

  _updateShortcut2(disable) {
    this.accel2.unlisten();

    let shortcut = '';
    try {
      shortcut = (this.secondary_shortcut_search || []).join('');
    } catch (err) {
      //
    }
    if (shortcut === '') {
      shortcut = '<Control><Super>Space';
    }

    if (!disable) {
      this.accel2.listenFor(shortcut, this._toggle_search_light.bind(this));
    }
  }

  _queryDisplay() {
    let idx = this.preferred_monitor || 0;
    if (idx === 0) {
      idx = Main.layoutManager.primaryIndex;
    } else if (idx === Main.layoutManager.primaryIndex) {
      idx = 0;
    }
    this.monitor =
      Main.layoutManager.monitors[idx] || Main.layoutManager.primaryMonitor;

    if (this.popup_at_cursor_monitor) {
      let pointer = global.get_pointer();
      Main.layoutManager.monitors.forEach((m) => {
        if (
          pointer[0] >= m.x &&
          pointer[0] <= m.x + m.width &&
          pointer[1] >= m.y &&
          pointer[1] <= m.y + m.height
        ) {
          this.monitor = m;
        }
      });
    }

    this.sw = this.monitor.width;
    this.sh = this.monitor.height;

    if (this._last_monitor_count !== Main.layoutManager.monitors.length) {
      this._settings.set_int(
        'monitor-count',
        Main.layoutManager.monitors.length,
      );
      this._last_monitor_count = Main.layoutManager.monitors.length;
    }
  }

  _acquire_ui() {
    if (this._entry) return;

    if (!Main.overview._toggle) {
      Main.overview._toggle = Main.overview.toggle;
    }
    Main.overview.toggle = () => {
      if (this._search && this._search.visible) {
        this._search._text.get_parent().grab_key_focus();
      }
    };
    if (!Main.overview._hide) {
      Main.overview._hide = Main.overview.hide;
    }
    Main.overview.hide = () => {
      this.mainContainer.opacity = 0;
      Main.overview._hide();
    };

    this._queryDisplay();

    this.scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

    this._entry = Main.overview.searchEntry;
    this._entryParent = this._entry.get_parent();
    this._entry.add_style_class_name('slc');

    this._search = Main.overview.searchController;

    this._search.hide();
    this._searchResults = this._search._searchResults;
    this._searchParent = this._search.get_parent();

    if (!this._searchResults._activateDefault) {
      this._searchResults._activateDefault =
        this._searchResults.activateDefault;
    }
    this._searchResults.activateDefault = () => {
      // hide window immediately when activated
      this.mainContainer.opacity = 0;
      this._searchResults._activateDefault();
    };

    if (this._entry.get_parent()) {
      this._entry.get_parent().remove_child(this._entry);
    }
    this.container.add_child(this._entry);
    if (this._search.get_parent()) {
      this._search.get_parent().remove_child(this._search);
    }
    this.container.add_child(this._search);
    if (!this._search.__searchCancelled) {
      this._search.__searchCancelled = this._search._searchCancelled;
      this._search._searchCancelled = () => {};
    }
    this._search._text.get_parent().grab_key_focus();
    this._textChangedEventId = this._search._text.connect(
      'text-changed',
      () => {
        this.container.set_size(this.width, this.height);
        this.mainContainer.set_size(this.width, this.height);
        if (this._corners) {
          this._corners[2].y = this.height - this._corners[1].height;
          this._corners[3].y = this.height - this._corners[1].height;
          this._edges[3].y = this.height - 2;
        }
        this._handleTextChanged(this._search._text.get_text());
      },
    );

    this._aiActivateId = this._search._text.connect('activate', () => {
      if (this._aiModeActive)
        this._sendAiMessage();
    });

    this._setupCustomPanels();

    this._search._text.get_parent().grab_key_focus();
  }

  _release_ui() {
    // Save non-prefixed search queries to history before releasing
    if (this.search_history_enabled && this._searchHistory && this._search && this._search._text) {
      let currentText = this._search._text.get_text();
      if (currentText && !currentText.startsWith('>') && !currentText.startsWith('?'))
        this._searchHistory.add(currentText);
    }

    if (this._entry) {
      if (this._entry.get_parent()) {
        this._entry.get_parent().remove_child(this._entry);
      }
      this._entryParent.add_child(this._entry);
      this._entry = null;
    }

    if (this._search) {
      this._removeProviders();
      this._search.hide();
      if (this._search.get_parent()) {
        this._search.get_parent().remove_child(this._search);
      }
      this._searchParent.add_child(this._search);
      if (this._textChangedEventId) {
        this._search._text.disconnect(this._textChangedEventId);
        this._textChangedEventId = null;
      }
      if (this._aiActivateId) {
        this._search._text.disconnect(this._aiActivateId);
        this._aiActivateId = null;
      }
      if (this._search.__searchCancelled) {
        this._search._searchCancelled = this._search.__searchCancelled;
        this._search.__searchCancelled = null;
      }
      this._search = null;

      if (this._searchResults._activateDefault) {
        this._searchResults.activateDefault =
          this._searchResults._activateDefault;
        this._searchResults._activateDefault = null;
      }
    }

    if (Main.overview._toggle) {
      Main.overview.toggle = Main.overview._toggle;
      Main.overview._toggle = null;
    }
    if (Main.overview._hide) {
      Main.overview.hide = Main.overview._hide;
      Main.overview._hide = null;
    }

    // Destroy custom panels added in _setupCustomPanels
    if (this._fileSearchPanel) {
      if (this._fileSearchPanel.get_parent())
        this._fileSearchPanel.get_parent().remove_child(this._fileSearchPanel);
      this._fileSearchPanel.destroy();
      this._fileSearchPanel = null;
      this._fileResultsList = null;
      this._filePanelHeader = null;
    }
    if (this._aiPanel) {
      if (this._aiPanel.get_parent())
        this._aiPanel.get_parent().remove_child(this._aiPanel);
      this._aiPanel.destroy();
      this._aiPanel = null;
      this._aiResponseLabel = null;
      this._aiStatusLabel = null;
    }
    this._aiModeActive = false;
  }

  _updateCss(_disable) {
    let bg = this.background_color || [0, 0, 0, 0.5];
    if (this.text_color && this.text_color[3] > 0) {
      this.container.remove_style_class_name('light');
    } else if (0.3 * bg[0] + 0.59 * bg[1] + 0.11 * bg[2] < 0.5) {
      this.container.remove_style_class_name('light');
    } else {
      this.container.add_style_class_name('light');
    }

    this._background.remove_effect_by_name('blur');
    if (this._blurEffect && this.blur_background) {
      this._background.add_effect_with_name('blur', this._blurEffect);
      this._blurEffect.color = bg;
    }

    this._background.visible = true;
    this._background.opacity = 200;

    let styles = [];
    {
      let ss = [];

      if (!this.blur_background) {
        let clr = this._style.rgba(this.background_color);
        ss.push(`\n  background: rgba(${clr});`);
      }

      if (
        this.border_thickness
        // && !this.blur_background
      ) {
        let clr = this._style.rgba(this.border_color);
        ss.push(`\n  border: ${this.border_thickness}px solid rgba(${clr});`);
      }

      styles.push(`#searchLight {${ss.join(' ')}}`);
      styles.push(`#searchLightBlurredBackground {${ss.join(' ')}}`);
    }

    // ss.push(`\n background-image: url("${bg}");`);
    if (
      this.blur_background &&
      this.desktop_background_blurred &&
      this.monitor
    ) {
      let sw = this.monitor.width;
      let sh = this.monitor.height;
      let ss = [];
      // ss.push(`\n background-image: url("${BLURRED_BG_PATH}");`);
      ss.push(
        `\n background-image: url("${this.desktop_background_blurred}");`,
      );
      ss.push(`\n background-size: ${sw}px ${sh}px;`);
      ss.push('\n background-position: top center;');
      // ss.push(`\n border: 2px solid red;`);
      this._background.style = ss.join(' ');

      // styles.push(`#searchLightBlurredBackground {${ss.join(' ')}}`);
      // styles.push(`#searchLight {${ss.join(' ')}}`);
    } else {
      this._background.style = '';
    }

    {
      if (this.border_radius !== null) {
        let rads = [0, 16, 18, 20, 22, 24, 28, 32];
        let r = rads[Math.floor(this.border_radius)];
        if (r) {
          let st = `StBoxLayout.search-section-content { border-radius: ${r}px !important; }`;
          st = `#searchLightBlurredBackgroundImage,\n${st}`; // has no effect
          st = `#searchLightBlurredBackground,\n${st}`; // has no effect
          st = `#searchLightBox,\n${st}`;
          st = `#searchLight,\n${st}`;
          styles.push(st);
        }
      }
    }

    if (this.font_size !== null) {
      let f = this.font_size_options[this.font_size];
      if (f) {
        styles.push(`#searchLightBox * { font-size: ${f}pt !important; }`);
      }
      f = this.entry_font_size_options[this.entry_font_size];
      if (f) {
        styles.push(
          `#searchLightBox > StEntry, #searchLightBox > StEntry:focus { font-size: ${f}pt !important; }`,
        );
      }
    }

    let clr = this._style.rgba(this.text_color);
    if ((this.text_color || [1, 1, 1, 1])[3] > 0) {
      styles.push(`#searchLightBox * { color: rgba(${clr}) !important }`);
    } else {
      styles.push('/* empty */');
    }

    // icon color
    {
      let ss = [];
      {
        let panelClr = this._style.rgba(this.panel_icon_color);
        if (this.panel_icon_color[3] > 0) {
          ss.push(`\n  color: rgba(${panelClr}) !important;`);
        }
      }
      styles.push(`.panel-status-indicator-icon {${ss.join(' ')}}`);
    }

    // console.log(styles);
    this._style.build('custom-search-light', styles);
  }

  _toggle_search_light() {
    if (this._inOverview) return;
    if (!this._visible) {
      this.show();
      if (this._entry) {
        global.stage.set_key_focus(this._entry);
      }
    } else {
      global.stage.set_key_focus(null);
    }
  }

  _add_events() {
    global.stage.connectObject(
      'notify::key-focus',
      this._onKeyFocusChanged.bind(this),
      'key-press-event',
      this._onKeyPressed.bind(this),
      this,
    );

    global.display.connectObject(
      'notify::focus-window',
      this._onFocusWindow.bind(this),
      'in-fullscreen-changed',
      this._onFullScreen.bind(this),
      this,
    );
  }

  _remove_events() {
    global.display.disconnectObject(this);
    global.stage.disconnectObject(this);
    Main.overview.disconnectObject(this);
    Shell.AppSystem.get_default().disconnectObject(this);
  }

  _onOverviewShowing() {
    this._inOverview = true;
  }

  _onOverviewHidden() {
    this._inOverview = false;
  }

  _onAppStateChanged(st) {
    this._lastAppState = st;
    if (this._visible) {
      this.mainContainer.opacity = 0;
    }
  }

  _hidePopups() {
    let popup = this._lastPopup;
    this._lastPopup = null;
    try {
      if (!popup.close && popup._getTopMenu()) {
        popup = popup._getTopMenu();
      }

      // elaborate way of hiding the popup
      popup.opacity = 0;
      this._startupSeq = this._hiTimer.runSequence([
        {
          func: () => {
            popup.opacity = 0;
          },
          delay: 0,
        },
        {
          func: () => {
            popup._delegate.close(false);
          },
          delay: 250,
        },
      ]);
    } catch (err) {
      logError(err);
    }
  }

  _onFocusWindow(_w, _e) {}

  _onKeyFocusChanged(_previous) {
    if (!this._entry) return;
    let focus = global.stage.get_key_focus();
    let appearFocused =
      focus && (this._entry.contains(focus) || this._searchResults.contains(focus));

    if (!appearFocused) {
      // popups are not handled well.. hide immediately
      if (
        focus &&
        focus.style_class &&
        focus.style_class.includes('popup-menu')
      ) {
        this._lastPopup = focus;
        this._hidePopups();
      }

      this.hide();
    }

    // hide window immediately when activated
    if (focus && focus.activate) {
      if (!focus._activate) {
        focus._activate = focus.activate;
        focus.activate = () => {
          this.mainContainer.opacity = 0;
          focus._activate();
        };
      }
    }
  }

  _onKeyPressed(obj, evt) {
    if (!this._entry) return;
    let focus = global.stage.get_key_focus();
    if (!focus || !this._entry.contains(focus)) {
      if (evt.get_key_symbol() === Clutter.KEY_Escape) {
        this.hide();
        return Clutter.EVENT_STOP;
      }
      this._search._text.get_parent().grab_key_focus();
    }

    return Clutter.EVENT_STOP;
  }

  _onFullScreen() {
    this.hide();
  }

  // ─── Services initialisation ─────────────────────────────────────────────

  _initServices() {
    this._fileSearch = new FileSearch();
    this._aiProvider = new AiProvider();
    this._aiMessages = [];
    this._aiConversationId = null;
    this._aiModeActive = false;

    if (this.search_history_enabled)
      this._searchHistory = new SearchHistory(this.search_history_max || 100);

    if (this.ai_history_enabled)
      this._aiHistory = new AiHistory(this.ai_history_max || 50);
  }

  // ─── Custom UI panels ────────────────────────────────────────────────────

  _setupCustomPanels() {
    // --- File search / history panel ---
    this._fileSearchPanel = new St.BoxLayout({
      name: 'searchLightFilePanel',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      visible: false,
    });

    this._filePanelHeader = new St.Label({
      text: 'File Results',
      style: 'font-weight: bold; padding: 4px 8px;',
      x_expand: true,
    });
    this._fileSearchPanel.add_child(this._filePanelHeader);

    let fileScrollView = new St.ScrollView({
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      clip_to_allocation: true,
      x_expand: true,
      style: 'max-height: 300px;',
    });
    this._fileResultsList = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    fileScrollView.add_child(this._fileResultsList);
    this._fileSearchPanel.add_child(fileScrollView);
    this.container.add_child(this._fileSearchPanel);

    // --- AI panel ---
    this._aiPanel = new St.BoxLayout({
      name: 'searchLightAiPanel',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      visible: false,
    });

    this._aiStatusLabel = new St.Label({
      text: 'AI · Type a question and press Enter',
      style: 'padding: 4px 8px; opacity: 0.7;',
      x_expand: true,
    });
    this._aiPanel.add_child(this._aiStatusLabel);

    let aiScrollView = new St.ScrollView({
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      clip_to_allocation: true,
      x_expand: true,
      style: 'min-height: 60px; max-height: 300px;',
    });
    this._aiResponseLabel = new St.Label({
      text: '',
      x_expand: true,
      style: 'padding: 8px;',
    });
    this._aiResponseLabel.clutter_text.line_wrap = true;
    this._aiResponseLabel.clutter_text.ellipsize = 0;
    aiScrollView.add_child(this._aiResponseLabel);
    this._aiPanel.add_child(aiScrollView);

    let aiToolbar = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      style: 'padding: 4px 8px; spacing: 8px;',
    });
    let aiNewBtn = new St.Button({
      label: '+ New Chat',
      style_class: 'button',
      can_focus: true,
    });
    aiNewBtn.connect('clicked', () => this._newAiConversation());

    let aiHistoryBtn = new St.Button({
      label: '\u23F1 History',
      style_class: 'button',
      can_focus: true,
    });
    aiHistoryBtn.connect('clicked', () => this._showAiHistory());

    aiToolbar.add_child(aiNewBtn);
    aiToolbar.add_child(aiHistoryBtn);
    this._aiPanel.add_child(aiToolbar);
    this.container.add_child(this._aiPanel);
  }

  // ─── Text routing ────────────────────────────────────────────────────────

  _handleTextChanged(text) {
    if (!this._fileSearchPanel || !this._aiPanel)
      return;

    if (text.startsWith('> ')) {
      let query = text.slice(2);
      this._search.hide();
      this._aiPanel.hide();
      this._aiModeActive = false;
      this._showFileMode(query);
    } else if (text.startsWith('? ')) {
      this._search.hide();
      this._fileSearchPanel.hide();
      this._showAiMode(text.slice(2));
    } else if (text === '' && this.search_history_enabled && this._searchHistory) {
      this._search.hide();
      this._aiModeActive = false;
      this._showSearchHistory();
    } else {
      this._hideCustomPanels();
      this._aiModeActive = false;
      this._search.show();
    }
  }

  _hideCustomPanels() {
    if (this._fileSearchPanel)
      this._fileSearchPanel.hide();
    if (this._aiPanel)
      this._aiPanel.hide();
  }

  // ─── File search ─────────────────────────────────────────────────────────

  _showFileMode(query) {
    this._fileSearchPanel.show();
    if (!this.file_search_enabled) {
      this._filePanelHeader.set_text('File Search · Disabled in settings');
      this._fileResultsList.destroy_all_children();
      return;
    }
    if (!query || query.trim().length < 2) {
      this._filePanelHeader.set_text('File Search · Type at least 2 characters');
      this._fileResultsList.destroy_all_children();
      return;
    }
    this._filePanelHeader.set_text(`File Search · Searching for "${query.trim()}"…`);
    this._fileSearch.search(query.trim(), {
      root: this.file_search_root || '~',
      maxResults: this.file_search_max_results || 50,
      useLocate: this.file_search_use_locate !== false,
    }, results => this._populateFileResults(results, query.trim()));
  }

  _populateFileResults(results, query) {
    if (!this._fileResultsList)
      return;
    this._fileResultsList.destroy_all_children();
    if (results.length === 0) {
      this._filePanelHeader.set_text(`File Search · No results for "${query}"`);
      return;
    }
    this._filePanelHeader.set_text(`File Search · ${results.length} result(s) for "${query}"`);
    results.forEach(path => this._fileResultsList.add_child(this._createFileResultItem(path)));
  }

  _createFileResultItem(path) {
    let btn = new St.Button({
      can_focus: true,
      track_hover: true,
      x_align: Clutter.ActorAlign.FILL,
      x_expand: true,
      style_class: 'search-result',
    });
    let box = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
    });
    let icon = new St.Icon({
      gicon: new Gio.ThemedIcon({ name: 'text-x-generic-symbolic' }),
      icon_size: 16,
      style: 'padding: 4px;',
    });
    let label = new St.Label({
      text: path,
      x_expand: true,
      style: 'padding: 4px 8px;',
    });
    box.add_child(icon);
    box.add_child(label);
    btn.set_child(box);
    btn.connect('clicked', () => {
      this._openFile(path);
      this.hide();
    });
    return btn;
  }

  _openFile(path) {
    try {
      let uri = Gio.File.new_for_path(path).get_uri();
      Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (e) {
      logError(e, `SearchLight: failed to open ${path}`);
    }
  }

  // ─── Search history ───────────────────────────────────────────────────────

  _showSearchHistory() {
    if (!this._searchHistory || !this._fileSearchPanel)
      return;
    let histEntries = this._searchHistory.entries.slice(0, 10);
    if (histEntries.length === 0) {
      this._fileSearchPanel.hide();
      return;
    }
    this._filePanelHeader.set_text('Recent Searches');
    this._fileResultsList.destroy_all_children();
    histEntries.forEach(entry => {
      let btn = new St.Button({
        can_focus: true,
        track_hover: true,
        x_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        style_class: 'search-result',
      });
      let label = new St.Label({
        text: entry.query,
        x_expand: true,
        style: 'padding: 4px 8px;',
      });
      btn.set_child(label);
      btn.connect('clicked', () => {
        if (this._search && this._search._text) {
          this._search._text.set_text(entry.query);
          this._search._text.set_cursor_position(-1);
        }
      });
      this._fileResultsList.add_child(btn);
    });
    this._fileSearchPanel.show();
  }

  // ─── AI mode ─────────────────────────────────────────────────────────────

  _showAiMode(queryText) {
    this._aiModeActive = true;
    this._aiPanel.show();
    let trimmed = queryText ? queryText.trim() : '';
    if (!this._aiResponseLabel.clutter_text.get_text()) {
      if (trimmed) {
        let preview = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
        this._aiStatusLabel.set_text(`AI · Ready — press Enter to send: "${preview}"`);
      } else {
        this._aiStatusLabel.set_text('AI · Type a question and press Enter');
      }
    }
  }

  _parseAiQuery(text) {
    let files = [];
    let query = text.replace(/@(\S+)/gu, (_match, filePath) => {
      let expanded = filePath;
      if (expanded.startsWith('~'))
        expanded = `${GLib.get_home_dir()}${expanded.slice(1)}`;
      files.push(expanded);
      return '';
    }).trim();
    return { query, files };
  }

  _sendAiMessage() {
    if (!this._search || !this._search._text)
      return;
    let inputText = this._search._text.get_text();
    if (!inputText.startsWith('? '))
      return;
    let queryText = inputText.slice(2).trim();
    if (!queryText)
      return;

    let { query, files } = this._parseAiQuery(queryText);
    if (!query)
      return;

    if (!this.ai_enabled) {
      if (this._aiStatusLabel)
        this._aiStatusLabel.set_text('AI · Enable AI mode in the extension settings');
      return;
    }
    if (!this.ai_api_key) {
      if (this._aiStatusLabel)
        this._aiStatusLabel.set_text('AI · Set your API key in the extension settings');
      return;
    }

    this._aiMessages.push({ role: 'user', content: query });

    if (!this._aiConversationId && this.ai_history_enabled && this._aiHistory)
      this._aiConversationId = this._aiHistory.newId();

    if (this._aiStatusLabel)
      this._aiStatusLabel.set_text('AI · Thinking…');
    if (this._aiResponseLabel)
      this._aiResponseLabel.set_text('…');

    this._aiProvider.query({
      provider: this.ai_provider || 0,
      apiKey: this.ai_api_key,
      messages: this._aiMessages.slice(),
      contextFiles: files,
      maxContextKb: this.ai_max_context_kb || 32,
    }, (error, response) => {
      if (!this._aiPanel)
        return;
      if (error) {
        this._aiMessages.pop();
        this._showAiResponse(`Error: ${error}`, true);
      } else {
        this._aiMessages.push({ role: 'assistant', content: response });
        this._showAiResponse(response, false);
        if (this._aiConversationId && this.ai_history_enabled && this._aiHistory)
          this._aiHistory.saveConversation(this._aiConversationId, this._aiMessages);
      }
    });

    // Clear entry but keep AI prefix for continuation
    this._search._text.set_text('? ');
    this._search._text.set_cursor_position(-1);
  }

  _showAiResponse(text, isError) {
    if (!this._aiResponseLabel || !this._aiStatusLabel)
      return;
    this._aiResponseLabel.set_text(text);
    let assistantCount = this._aiMessages.filter(m => m.role === 'assistant').length;
    if (isError)
      this._aiStatusLabel.set_text('AI · Error — check your API key and try again');
    else
      this._aiStatusLabel.set_text(`AI · ${assistantCount} response(s) — type ? to continue`);
  }

  _newAiConversation() {
    this._aiMessages = [];
    this._aiConversationId = null;
    if (this._aiResponseLabel)
      this._aiResponseLabel.set_text('');
    if (this._aiStatusLabel)
      this._aiStatusLabel.set_text('AI · Type a question and press Enter');
  }

  _showAiHistory() {
    if (!this.ai_history_enabled || !this._aiHistory || !this._fileSearchPanel)
      return;
    let conversations = this._aiHistory.listConversations();
    if (conversations.length === 0) {
      if (this._aiStatusLabel)
        this._aiStatusLabel.set_text('AI · No saved conversations yet');
      return;
    }
    this._filePanelHeader.set_text('AI Chat History');
    this._fileResultsList.destroy_all_children();
    conversations.forEach(conv => {
      let btn = new St.Button({
        can_focus: true,
        track_hover: true,
        x_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        style_class: 'search-result',
      });
      let when = new Date(conv.timestamp).toLocaleDateString();
      let labelText = conv.preview ? `${conv.preview} (${when})` : when;
      let label = new St.Label({
        text: labelText,
        x_expand: true,
        style: 'padding: 4px 8px;',
      });
      btn.set_child(label);
      btn.connect('clicked', () => this._loadAiConversation(conv.id));
      this._fileResultsList.add_child(btn);
    });
    this._fileSearchPanel.show();
  }

  _loadAiConversation(convId) {
    if (!this._aiHistory)
      return;
    let data = this._aiHistory.loadConversation(convId);
    if (!data)
      return;
    this._aiMessages = data.messages.slice();
    this._aiConversationId = convId;
    let lastAssistant = this._aiMessages.filter(m => m.role === 'assistant').pop();
    if (lastAssistant && this._aiResponseLabel)
      this._aiResponseLabel.set_text(lastAssistant.content);
    if (this._aiStatusLabel)
      this._aiStatusLabel.set_text(`AI · Resumed (${this._aiMessages.length} messages)`);
    if (this._fileSearchPanel)
      this._fileSearchPanel.hide();
    if (this._aiPanel)
      this._aiPanel.show();
  }
}
