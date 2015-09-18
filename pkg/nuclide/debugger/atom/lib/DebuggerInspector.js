'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

var BreakpointStore = require('./BreakpointStore');
var Bridge = require('./Bridge');
var DebuggerActions = require('./DebuggerActions');
var React = require('react-for-atom');
var path = require('path');
var {PanelComponent} = require('nuclide-panel');

/**
 * Wrapper for Chrome Devtools frontend view.
 */
var DebuggerInspector = React.createClass({
  _webviewNode: (null: ?Object),

  displayName: 'DebuggerInspector',

  propTypes: {
    actions: React.PropTypes.instanceOf(DebuggerActions).isRequired,
    breakpointStore: React.PropTypes.instanceOf(BreakpointStore).isRequired,
    socket: React.PropTypes.string.isRequired,
    bridge: React.PropTypes.instanceOf(Bridge).isRequired,
  },

  render(): ?ReactElement {
    return (
      <PanelComponent initialLength={500} dock="right">
        <div className="inspector">
          <div className="control-bar" ref="controlBar">
            <button
              title="Detach from the current process."
              className="icon icon-x"
              style={{color: 'red'}}
              onClick={this._handleClickClose} />
            <button
              title="(Debug) Open Web Inspector for the debugger frame."
              className="icon icon-gear"
              style={{color: 'grey'}}
              onClick={this._handleClickDevTools} />
          </div>
        </div>
      </PanelComponent>
    );
  },

  componentDidMount() {
    // Cast from HTMLElement down to WebviewElement without instanceof
    // checking, as WebviewElement constructor is not exposed.
    var webviewNode = ((document.createElement('webview'): any): WebviewElement);
    webviewNode.src = this._getUrl();
    webviewNode.nodeintegration = true;
    webviewNode.disablewebsecurity = true;
    webviewNode.classList.add('native-key-bindings'); // required to pass through certain key events
    webviewNode.classList.add('nuclide-debugger-webview');
    this._webviewNode = webviewNode;
    var controlBarNode = React.findDOMNode(this.refs.controlBar);
    controlBarNode.parentNode.insertBefore(webviewNode, controlBarNode.nextSibling);
    this.props.bridge.setWebviewElement(webviewNode);
  },

  componentDidUpdate() {
    var webviewNode = this._webviewNode;
    if (webviewNode) {
      webviewNode.src = this._getUrl();
    }
  },

  componentWillUnmount() {
    if (this.props.bridge) {
      this.props.bridge.cleanup();
    }
    this._webviewNode = null;
  },

  _getUrl(): string {
    var packagePath = path.resolve(path.dirname(module.filename), '../');
    return `${packagePath}/scripts/inspector.html?${this.props.socket}`;
  },

  _handleClickClose() {
    this.props.actions.killDebugger();
  },

  _handleClickDevTools() {
    var webviewNode = this._webviewNode;
    if (webviewNode) {
      webviewNode.openDevTools();
    }
  },
});

module.exports = DebuggerInspector;