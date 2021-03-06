'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */


var {CompositeDisposable} = require('atom');
var {getPath} = require('nuclide-remote-uri');
var {track} = require('nuclide-analytics');

import type {NuclideUri} from 'nuclide-remote-uri';

function copyAbsolutePath(): void {
  trackOperation('copyAbsolutePath');

  var uri = getCurrentNuclideUri();
  if (!uri) {
    return;
  }
  copyToClipboard('Copied absolute path', getPath(uri));
}

function copyProjectRelativePath(): void {
  trackOperation('copyProjectRelativePath');

  var uri = getCurrentNuclideUri();
  if (!uri) {
    return;
  }

  var projectRelativePath = getAtomProjectRelativePath(uri);
  if (projectRelativePath) {
    copyToClipboard('Copied project relative path', projectRelativePath);
  } else {
    copyToClipboard('Path not contained in any open project.\nCopied absolute path', getPath(uri));
  }
}

async function copyRepositoryRelativePath(): Promise {
  trackOperation('copyRepositoryRelativePath');

  var uri = getCurrentNuclideUri();
  if (!uri) {
    return;
  }

  // First source control relative.
  var repoRelativePath = getRepositoryRelativePath(uri);
  if (repoRelativePath) {
    copyToClipboard('Copied repository relative path', repoRelativePath);
    return;
  }

  // Next try arcanist relative.
  var arcRelativePath = await getArcanistRelativePath(uri);
  if (arcRelativePath) {
    copyToClipboard('Copied arc project relative path', arcRelativePath);
    return;
  }

  // Lastly, project and absolute.
  var projectRelativePath = getAtomProjectRelativePath(uri);
  if (projectRelativePath) {
    copyToClipboard('Copied project relative path', projectRelativePath);
  } else {
    copyToClipboard('Path not contained in any repository.\nCopied absolute path', getPath(uri));
  }
}

function getAtomProjectRelativePath(path: NuclideUri): ?string {
  var [projectPath, relativePath] = atom.project.relativizePath(path);
  if (!projectPath) {
    return null;
  }
  return relativePath;
}

function getRepositoryRelativePath(path: NuclideUri): ?string {
  // TODO(peterhal): repositoryForPath is the same as projectRelativePath
  // only less robust. We'll need a version of findHgRepository which is
  // aware of remote paths.
  return null;
}

function getArcanistRelativePath(path: NuclideUri): Promise<?string> {
  var {getProjectRelativePath} = require('nuclide-arcanist-client');
  return getProjectRelativePath(path);
}

function copyToClipboard(messagePrefix: string, value: string): void {
  atom.clipboard.write(value);
  notify(`${messagePrefix}: ${value}`);
}

function getCurrentNuclideUri(): ?NuclideUri {
  var editor = atom.workspace.getActiveTextEditor();
  if (!editor) {
    notify('Nothing copied. No active text editor.');
    return null;
  }

  var path = editor.getPath();
  if (!path) {
    notify('Nothing copied. Current text editor is unnamed.');
    return null;
  }

  return path;
}

function trackOperation(operation: string): void {
  track('nuclide-clipboard-path:' + operation, {});
}

function notify(message: string): void {
  atom.notifications.addInfo(message);
}

class Activation {
  _subscriptions: CompositeDisposable;

  constructor(state: ?Object) {
    this._subscriptions = new CompositeDisposable();
    this._subscriptions.add(
      atom.commands.add('atom-workspace',
      'nuclide-clipboard-path:copy-absolute-path', copyAbsolutePath)
    );
    this._subscriptions.add(
      atom.commands.add('atom-workspace',
      'nuclide-clipboard-path:copy-repository-relative-path', copyRepositoryRelativePath)
    );
    this._subscriptions.add(
      atom.commands.add('atom-workspace',
      'nuclide-clipboard-path:copy-project-relative-path', copyProjectRelativePath)
    );
  }

  dispose() {
    this._subscriptions.dispose();
  }
}

var activation: ?Activation = null;

module.exports = {

  activate(state: ?mixed): void {
    if (!activation) {
      activation = new Activation();
    }
  },

  deactivate(): void {
    if (activation) {
      activation.dispose();
      activation = null;
    }
  },
};
