'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {HgRepositoryClient} from 'nuclide-hg-repository-client';
import type {FileChangeState} from './types';

var {CompositeDisposable, Emitter} = require('atom');
var {repositoryForPath} = require('nuclide-hg-git-bridge');
var {HgStatusToFileChangeStatus, FileChangeStatus} = require('./constants');
var {track} = require('nuclide-analytics');

var {getFileForPath} = require('nuclide-client');
var logger = require('nuclide-logging').getLogger();

type HgDiffState = {
  committedContents: string;
  filesystemContents: string;
};

class DiffViewModel {

  _emitter: Emitter;
  _subscriptions: ?CompositeDisposable;
  _activeSubscriptions: ?CompositeDisposable;
  _activeFileState: FileChangeState;
  _newEditor: ?TextEditor;
  _fileChanges: Map<string, number>;
  _uiProviders: Array<Object>;
  _repositorySubscriptions: ?Map<HgRepositoryClient, Disposable>;

  constructor(uiProviders: Array<Object>) {
    this._uiProviders = uiProviders;
    this._fileChanges = new Map();
    this._emitter = new Emitter();
    var subscriptions = this._subscriptions = new CompositeDisposable();
    this._repositorySubscriptions = new Map();
    this._updateRepositories();
    subscriptions.add(atom.project.onDidChangePaths(this._updateRepositories.bind(this)));
    this._setActiveFileState({
      filePath: '',
      oldContents: '',
      newContents: '',
    });
  }

  _updateRepositories(): void {
    for (var subscription of this._repositorySubscriptions.values()) {
      subscription.dispose();
    }
    this._repositorySubscriptions.clear();
    atom.project.getRepositories()
      .filter(repository => repository && repository.getType() === 'hg')
      .forEach(repository => {
        // Get the initial project status, if it's not already there,
        // triggered by another integration, like the file tree.
        repository.getStatuses([repository.getProjectDirectory()]);
        this._repositorySubscriptions.set(
          repository, repository.onDidChangeStatuses(this._updateChangedStatus.bind(this))
        );
      });
    this._updateChangedStatus();
  }

  _updateChangedStatus(): void {
    this._fileChanges.clear();
    for (var repository of this._repositorySubscriptions.keys()) {
      var statuses = repository.getAllPathStatuses();
      for (var filePath in statuses) {
        var changeStatus = HgStatusToFileChangeStatus[statuses[filePath]];
        if (changeStatus != null) {
          this._fileChanges.set(filePath, changeStatus);
        }
      }
    }
    this._emitter.emit('did-change-status', this._fileChanges);
  }

  activateFile(filePath: string): void {
    if (this._activeSubscriptions) {
      this._activeSubscriptions.dispose();
    }
    var activeSubscriptions = this._activeSubscriptions = new CompositeDisposable();
    this._setActiveFileState({
      filePath,
      oldContents: '',
      newContents: '',
    });
    var file = getFileForPath(filePath);
    if (file) {
      activeSubscriptions.add(file.onDidChange(() => this._updateActiveDiffState(filePath)));
    }
    track('diff-view-open-file', {filePath});
    this._updateActiveDiffState(filePath).catch(this._handleInternalError.bind(this));
  }

  _handleInternalError(error: Error): void {
    var errorMessage = `Diff View Internal Error - ${error.message}`;
    logger.error(errorMessage, error);
    atom.notifications.addError(errorMessage);
  }

  setNewContents(newContents: string): void {
    var {filePath, oldContents, inlineComponents} = this._activeFileState;
    this._setActiveFileState({
      filePath,
      oldContents,
      newContents,
      inlineComponents,
    });
  }

  getActiveFileState(): FileChangeState {
    return this._activeFileState;
  }

  async _updateActiveDiffState(filePath: string): Promise<void> {
    var hgDiffState = await this._fetchHgDiff(filePath);
    if (!hgDiffState) {
      return;
    }
    var {
      committedContents: oldContents,
      filesystemContents: newContents,
    } = hgDiffState;
    this._setActiveFileState({
      filePath,
      oldContents,
      newContents,
    });
    var inlineComponents = await this._fetchInlineComponents();
    this._setActiveFileState({
      filePath,
      oldContents,
      newContents,
      inlineComponents,
    });
  }

  _setActiveFileState(state: FileChangeState): void {
    this._activeFileState = state;
    this._emitter.emit('active-file-update', state);
  }

  async _fetchHgDiff(filePath: string): Promise<?HgDiffState> {
    // Calling atom.project.repositoryForDirectory gets the real path of the directory,
    // which is another round-trip and calls the repository providers to get an existing repository.
    // Instead, the first match of the filtering here is the only possible match.
    var repository: HgRepositoryClient = repositoryForPath(filePath);

    // TODO(most): move repo type check error handling up the stack before creating the the view.
    if (!repository || repository.getType() !== 'hg') {
      var type = repository ? repository.getType() : 'no repository';
      throw new Error(`Diff view only supports \`Mercurial\` repositories, but found \`${type}\``);
    }

    var {getClient} = require('nuclide-client');
    var client = getClient(filePath);
    if (!client) {
      throw new Error(`client find for file: \`${filePath}\`.`);
    }

    var {getPath} = require('nuclide-remote-uri');
    var localFilePath = getPath(filePath);
    var stats;
    try {
      stats = await client.lstat(localFilePath);
    } catch (err) {
      var errorMessage = `lstat for file: \`${filePath}\` - ${err.toString()}`;
      throw new Error(errorMessage);
    }
    if (!stats || !stats.isFile()) {
      // The diff view is already open and showing all change statuses.
      // There is nothing to do if that was a directory.
      logger.info(`Diff View activated with a non-file path: ${filePath}`);
      return null;
    }

    var committedContentsPromise = repository.fetchFileContentAtRevision(filePath)
      // If the file didn't exist on the previous revision, return empty contents.
      .then(contents => contents || '', err => '');

    var filesystemContentsPromise = client.readFile(localFilePath, 'utf8')
      // If the file was removed, return empty contents.
      .then(contents => contents || '', err => '');

    var [
      committedContents,
      filesystemContents,
    ] = await Promise.all([committedContentsPromise, filesystemContentsPromise]);
    return {
      committedContents,
      filesystemContents,
    };
  }

  async saveActiveFile(): Promise<void> {
    var {filePath, newContents} = this._activeFileState;
    track('diff-view-save-file', {filePath});
    try {
      await this._saveFile(filePath, newContents);
    } catch(error) {
      this._handleInternalError(error);
      throw error;
    }
  }

  async _saveFile(filePath: string, newContents: string) {
    var client = require('nuclide-client').getClient(filePath);
    var localFilePath = require('nuclide-remote-uri').getPath(filePath);
    if (!client) {
      throw new Error(`client find while saving: \`${filePath}\`.`);
    }
    try {
      await client.writeFile(localFilePath, newContents);
    } catch (err) {
      throw new Error(`could not save file: \`${filePath}\` - ${err.toString()}`);
    }
  }

  onDidChangeStatus(callback: () => void): atom$Disposable {
    return this._emitter.on('did-change-status', callback);
  }

  onActiveFileUpdates(callback: () => void): atom$Disposable {
    return this._emitter.on('active-file-update', callback);
  }

  async _fetchInlineComponents(): Promise<Array<Object>> {
    var {filePath} = this._activeFileState;
    var uiElementPromises = this._uiProviders.map(provider => provider.composeUiElements(filePath));
    var uiComponentLists = await Promise.all(uiElementPromises);
    // Flatten uiComponentLists from list of lists of components to a list of components.
    var uiComponents = [].concat.apply([], uiComponentLists);
    return uiComponents;
  }

  getFileChanges(): Map<string, number> {
    return this._fileChanges;
  }

  onDidDestroy(callback: () => void): atom$Disposable {
    return this._emitter.on('did-destroy', callback);
  }

  destroy(): void {
    this._dispose();
    this._emitter.emit('did-destroy');
  }

  _dispose(): void {
    if (this._subscriptions) {
      this._subscriptions.dispose();
      this._subscriptions = null;
    }
    if (this._repositorySubscriptions) {
      for (var subscription of this._repositorySubscriptions.values()) {
        subscription.dispose();
      }
      this._repositorySubscriptions.clear();
      this._repositorySubscriptions = null;
    }
    if (this._activeSubscriptions) {
      this._activeSubscriptions.dispose();
      this._activeSubscriptions = null;
    }
  }
}

module.exports = DiffViewModel;
