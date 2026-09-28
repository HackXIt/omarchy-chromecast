import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "hackxit.chromecast"

  property string ipcTarget: "hackxit.chromecast"
  property bool opened: false
  property bool popoutSwitchClosing: false
  readonly property color barForeground: bar ? bar.barForeground : Color.foreground

  function open() { opened = true }
  function close() { opened = false }
  function toggle() { opened ? close() : open() }
  function closeForPopoutSwitch() {
    popoutSwitchClosing = true
    close()
    Qt.callLater(function() { popoutSwitchClosing = false })
  }
  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function") return bar.switchPanelFrom(root, direction)
    return false
  }

  property string statusText: ""
  property string statusTooltip: "Chromecast"
  property string statusClass: ""
  property bool statusActive: false
  property bool statusBusy: false
  property string activeSink: ""
  property var sinks: []
  property string actionStatus: ""
  property string lastError: ""
  property bool targetRefreshError: false
  property string focusSection: "actions"
  property int actionIndex: 0
  property int sinkIndex: 0
  property bool cursorActive: false

  readonly property string bundledCastctl: Quickshell.env("HOME") + "/.config/omarchy/plugins/hackxit.chromecast/bin/chromium-castctl"
  readonly property string configuredCastctl: String(setting("castctl", bundledCastctl))
  readonly property string castctl: safeCastctlPath(configuredCastctl) ? configuredCastctl : bundledCastctl
  readonly property int intervalMs: Math.max(1000, Number(setting("intervalMs", 5000)))
  readonly property int maxSinkCount: 64
  readonly property int maxSinkNameLength: 160
  readonly property int maxHelperTextLength: 65536
  readonly property bool alwaysVisible: setting("alwaysVisible", false) === true
  readonly property bool fitDisplay: setting("fitDisplay", true) !== false
  readonly property bool commandBusy: actionProc.running || sinksProc.running
  readonly property bool busy: statusBusy || commandBusy
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color idleIconColor: Qt.darker(barForeground, 1.55)
  readonly property color activeIconColor: barForeground
  readonly property string heroTitle: activeSink !== "" ? activeSink : "Chromecast"
  readonly property string heroMeta: statusBusy ? statusTooltip : (statusActive ? "Desktop mirroring is active" : "Ready to cast this desktop")
  readonly property string heroDetail: statusBusy ? "BUSY" : (statusActive ? "ACTIVE" : "IDLE")
  readonly property string toggleHint: statusActive ? "Stop casting" : "Choose a target"
  readonly property var actions: buildActions()

  visible: alwaysVisible || statusText !== "" || lastError !== ""
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function classContains(klass, needle) {
    if (Array.isArray(klass)) return klass.indexOf(needle) !== -1
    return String(klass || "").toLowerCase().indexOf(needle) !== -1
  }

  function neutralizeMarkup(value) {
    return safeDisplayText(value, maxHelperTextLength).replace(/</g, "‹").replace(/>/g, "›")
  }

  function safeCastctlPath(value) {
    var text = String(value || "")
    // Reject C0 controls (U+0000-U+001F) and DEL/C1 controls (U+007F-U+009F) in helper paths.
    return text.indexOf("/") === 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(text)
  }

  function limitRawText(value, maxLength) {
    var text = String(value || "")
    var limit = Math.max(1, Number(maxLength || maxHelperTextLength))
    if (text.length > limit) return text.slice(0, limit - 1) + "…"
    return text
  }

  function safeDisplayText(value, maxLength) {
    // Replace C0 controls (U+0000-U+001F), DEL/C1 controls (U+007F-U+009F),
    // and bidi override/isolate controls (U+202A-U+202E, U+2066-U+2069) in untrusted display text.
    var text = String(value || "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�")
    return limitRawText(text, maxLength)
  }

  function normalizedSinkRecord(value) {
    if (!value) return null
    var name = safeDisplayText(value.name || "", maxSinkNameLength).trim()
    var displayName = safeDisplayText(value.displayName || name, maxSinkNameLength + 40).trim()
    if (name === "" || displayName === "") return null
    return {
      name: name,
      displayName: displayName,
      startable: value.startable !== false && value.ambiguous !== true,
      ambiguous: value.ambiguous === true,
      duplicateCount: Number(value.duplicateCount || 1)
    }
  }

  function buildActions() {
    var rows = []
    rows.push({ kind: "pick", icon: "󰐊", label: statusActive ? "Change target" : "Start casting", subtitle: sinks.length > 0 ? "Choose from the targets below" : "Scan for available Chromecast targets", enabled: !commandBusy })
    rows.push({ kind: "stop", icon: "", label: "Stop casting", subtitle: statusActive ? "Stop the active desktop mirror" : "Stop mirroring or close the control session", enabled: !commandBusy })
    rows.push({ kind: "refresh", icon: "󰑐", label: "Refresh targets", subtitle: sinksProc.running ? "Scanning…" : "Update status and available sinks", enabled: !sinksProc.running })
    rows.push({ kind: "doctor", icon: "󰒡", label: "Run doctor", subtitle: "Open diagnostics in a floating terminal", enabled: true })
    rows.push({ kind: "quit", icon: "󰗼", label: "Quit control browser", subtitle: "Close the isolated Chromium controller", enabled: !commandBusy })
    return rows
  }

  function parseStatus(raw) {
    var trimmed = String(raw || "").trim()
    if (trimmed === "") {
      statusText = ""
      statusTooltip = "Chromecast"
      statusClass = ""
      statusActive = false
      statusBusy = false
      activeSink = ""
      return
    }

    try {
      var data = JSON.parse(trimmed)
      statusText = neutralizeMarkup(data.text || "")
      statusTooltip = neutralizeMarkup(data.tooltip || "Chromecast")
      statusClass = data.class || data.alt || ""
      statusActive = classContains(statusClass, "active") || classContains(statusClass, "playing")
      statusBusy = classContains(statusClass, "busy")
      activeSink = ""
      if (statusActive) {
        var prefix = "Casting to "
        if (statusTooltip.indexOf(prefix) === 0) activeSink = statusTooltip.slice(prefix.length)
        else activeSink = statusText.replace(/^\S+\s*/, "")
      }
      if (!statusBusy && lastError === "chromium-castctl status failed") lastError = ""
    } catch (e) {
      statusText = ""
      statusTooltip = neutralizeMarkup(trimmed)
      statusClass = ""
      statusActive = false
      statusBusy = false
      activeSink = ""
    }
  }

  function parseSinks(raw) {
    var rows = []
    var warning = ""
    var validResponse = false
    try {
      var data = JSON.parse(String(raw || ""))
      var items
      if (Array.isArray(data)) items = data
      else if (data && Array.isArray(data.sinks)) items = data.sinks
      else throw new Error("Invalid structured sink response")
      for (var i = 0; i < items.length && rows.length < maxSinkCount; i++) {
        var record = normalizedSinkRecord(items[i])
        if (!record) throw new Error("Invalid structured sink record")
        rows.push(record)
      }
      validResponse = true
      if (items.length > maxSinkCount) warning = "Too many Chromecast targets; showing the first " + maxSinkCount + "."
    } catch (e) {
      rows = []
      targetRefreshError = true
      lastError = "Invalid structured Chromecast target response"
    }
    sinks = rows
    if (targetRefreshError && validResponse) {
      lastError = ""
      targetRefreshError = false
    }
    if (warning !== "") lastError = warning
    if (sinkIndex >= sinks.length) sinkIndex = Math.max(0, sinks.length - 1)
    ensureCursor()
  }

  function refresh() {
    if (!statusProc.running) statusProc.running = true
  }

  function refreshSinks() {
    if (sinksProc.running) return
    sinksProc.outputText = ""
    sinksProc.errorText = ""
    if (targetRefreshError) {
      lastError = ""
      targetRefreshError = false
    }
    sinksProc.command = [castctl, "sinks", "--json"]
    sinksProc.running = true
  }

  function refreshAll() {
    refresh()
    refreshSinks()
  }

  function shellQuote(value) {
    if (bar && typeof bar.shellQuote === "function") return bar.shellQuote(value)
    return "'" + String(value || "").replace(/'/g, "'\"'\"'") + "'"
  }

  function runDoctor() {
    if (!bar || typeof bar.run !== "function") {
      lastError = "Cannot launch Chromecast doctor without the bar host."
      return
    }
    var command = shellQuote(castctl) + " doctor --quickshell"
    bar.run("omarchy-launch-floating-terminal-with-presentation " + shellQuote(command))
    actionStatus = "Opened Chromecast doctor in a terminal."
    close()
  }

  function runCastctl(args, label, closePanel) {
    if (actionProc.running) {
      actionStatus = "Chromecast action already running…"
      return
    }
    actionProc.outputText = ""
    actionProc.errorText = ""
    actionStatus = label
    lastError = ""
    targetRefreshError = false
    actionProc.command = [castctl].concat(args)
    actionProc.running = true
    refreshSoon.restart()
    if (closePanel) close()
  }

  function chooseTarget() {
    if (commandBusy) return
    if (sinks.length === 1 && sinks[0].startable !== false) {
      startSink(sinks[0])
      return
    }
    if (sinks.length > 0) {
      cursorActive = true
      focusSection = "sinks"
      sinkIndex = 0
      actionStatus = "Choose a Chromecast target below. Ambiguous duplicate names are disabled."
      return
    }
    actionStatus = "Scanning for Chromecast targets…"
    refreshSinks()
  }

  function pickTarget() { chooseTarget() }
  function stopCasting() { runCastctl(["stop"], "Stopping Chromecast cast…", false) }
  function quitBrowser() { runCastctl(["quit-browser"], "Closing Chromium control browser…", false) }
  function startSink(sink) {
    var record = typeof sink === "object" ? sink : { name: String(sink || ""), displayName: String(sink || ""), startable: true }
    if (!record || !record.name) return
    if (record.startable === false || record.ambiguous === true) {
      actionStatus = "Cannot start " + String(record.displayName || record.name) + "; duplicate receiver names are ambiguous."
      return
    }
    var args = ["start", String(record.name)]
    if (!fitDisplay) args.push("--no-fit-display")
    runCastctl(args, "Starting cast to " + String(record.displayName || record.name) + "…", true)
  }
  function toggleCast() { statusActive ? stopCasting() : pickTarget() }

  function activateAction(kind) {
    if (kind === "pick") pickTarget()
    else if (kind === "stop") stopCasting()
    else if (kind === "refresh") refreshAll()
    else if (kind === "doctor") runDoctor()
    else if (kind === "quit") quitBrowser()
  }

  function ensureCursor() {
    if (actionIndex >= actions.length) actionIndex = Math.max(0, actions.length - 1)
    if (sinkIndex >= sinks.length) sinkIndex = Math.max(0, sinks.length - 1)
    if (focusSection === "sinks" && sinks.length === 0) focusSection = "actions"
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()
    if (dy === 0) return
    if (focusSection === "actions") {
      if (dy > 0) {
        if (actionIndex < actions.length - 1) actionIndex++
        else if (sinks.length > 0) focusSection = "sinks"
      } else if (actionIndex > 0) {
        actionIndex--
      }
    } else if (focusSection === "sinks") {
      if (dy > 0) {
        if (sinkIndex < sinks.length - 1) sinkIndex++
      } else {
        if (sinkIndex > 0) sinkIndex--
        else focusSection = "actions"
      }
    }
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "actions") {
      var action = actions[Math.max(0, Math.min(actionIndex, actions.length - 1))]
      if (action && action.enabled !== false) activateAction(action.kind)
    } else if (focusSection === "sinks") {
      startSink(sinks[Math.max(0, Math.min(sinkIndex, sinks.length - 1))])
    }
  }

  function setActionCursor(index) {
    cursorActive = true
    focusSection = "actions"
    actionIndex = index
  }

  function setSinkCursor(index) {
    cursorActive = true
    focusSection = "sinks"
    sinkIndex = index
  }

  onOpenedChanged: if (opened) {
    cursorActive = false
    actionIndex = 0
    sinkIndex = 0
    if (panelFlick) panelFlick.contentY = 0
    refreshAll()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Component.onCompleted: refresh()

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshAll(); return "ok" }
    function status(): string { return root.statusTooltip }
    function stop(): string { root.stopCasting(); return "ok" }
    function pick(): string { root.pickTarget(); return "ok" }
    function doctor(): string { root.runDoctor(); return "ok" }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: root.statusTooltip
    iconComponent: Component {
      Item {
        Text {
          anchors.centerIn: parent
          text: ""
          color: root.lastError !== "" ? root.urgent : (root.statusActive || root.statusBusy ? root.activeIconColor : root.idleIconColor)
          font.family: root.fontFamily
          font.pixelSize: Style.bar.iconFont
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.stopCasting()
      else if (buttonCode === Qt.MiddleButton) root.refreshAll()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(390))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { root.moveCursor(dx, dy) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refreshAll()
        else if (t === "s" || t === "S") root.stopCasting()
        else if (t === "p" || t === "P") root.pickTarget()
        else if (t === "d" || t === "D") root.runDoctor()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            id: hero
            width: parent.width
            title: root.heroTitle
            meta: root.heroMeta
            detail: root.heroDetail
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: root.statusActive || root.statusBusy ? 1.0 : 0.55
            iconComponent: Component {
              Text {
                text: ""
                color: root.statusActive || root.statusBusy ? root.foreground : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            trailingControl: Component {
              PanelActionButton {
                iconText: root.statusActive ? "" : "󰐊"
                tooltipText: root.toggleHint
                foreground: hero.foreground
                fontFamily: hero.fontFamily
                enabled: !root.commandBusy
                onClicked: root.toggleCast()
              }
            }
          }

          Text {
            visible: root.actionStatus !== "" || root.lastError !== ""
            width: parent.width
            text: root.lastError !== "" ? root.lastError : root.actionStatus
            textFormat: Text.PlainText
            color: root.lastError !== "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          PanelSeparator { foreground: root.foreground }

          Column {
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "ACTIONS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.actions
              ActionRow {
                required property var modelData
                required property int index
                width: parent.width
                action: modelData
                rowIndex: index
              }
            }
          }

          PanelSeparator { foreground: root.foreground }

          Column {
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "TARGETS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              visible: root.sinks.length === 0
              width: parent.width
              text: sinksProc.running ? "Scanning for Chromecast targets…" : "No Chromecast targets found. Make sure the target is awake and on this network."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Column {
              id: sinkColumn
              visible: root.sinks.length > 0
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: root.sinks
                SinkRow {
                  required property var modelData
                  required property int index
                  width: parent.width
                  sink: modelData
                  rowIndex: index
                }
              }
            }
          }

        }
      }
    }
  }

  Timer {
    interval: root.intervalMs
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: refreshSoon
    interval: 800
    onTriggered: root.refresh()
  }

  Timer {
    id: delayedRefresh
    interval: 1600
    onTriggered: root.refreshAll()
  }

  Process {
    id: statusProc
    command: [root.castctl, "status", "--waybar"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.parseStatus(root.safeDisplayText(text, root.maxHelperTextLength)) }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.targetRefreshError = false
        root.lastError = "chromium-castctl status failed"
        root.statusText = ""
        root.statusTooltip = root.neutralizeMarkup(root.safeDisplayText(statusStderr.text || "Chromecast status failed", root.maxHelperTextLength).trim())
        root.statusActive = false
        root.statusBusy = false
      }
    }
  }

  Process {
    id: sinksProc
    property string outputText: ""
    property string errorText: ""
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: sinksProc.outputText = root.limitRawText(text, root.maxHelperTextLength) }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: sinksProc.errorText = root.safeDisplayText(text, root.maxHelperTextLength) }
    onExited: function(exitCode) {
      if (exitCode === 0) root.parseSinks(outputText)
      else {
        root.targetRefreshError = true
        root.lastError = root.safeDisplayText(errorText || outputText || "Could not list Chromecast targets", root.maxHelperTextLength).trim()
      }
    }
  }

  Process {
    id: actionProc
    property string outputText: ""
    property string errorText: ""
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: actionProc.outputText = root.safeDisplayText(text, root.maxHelperTextLength) }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: actionProc.errorText = root.safeDisplayText(text, root.maxHelperTextLength) }
    onExited: function(exitCode) {
      var out = String(outputText || "").trim()
      var err = String(errorText || "").trim()
      if (exitCode === 0) {
        if (out !== "") root.actionStatus = out
        var action = actionProc.command.length > 1 ? String(actionProc.command[1]) : ""
        if (action === "start" && actionProc.command.length > 2) {
          root.activeSink = root.safeDisplayText(actionProc.command[2], root.maxSinkNameLength)
          root.statusActive = true
          root.statusBusy = false
          root.statusClass = "active"
          root.statusText = " " + root.neutralizeMarkup(root.activeSink)
          root.statusTooltip = "Casting to " + root.neutralizeMarkup(root.activeSink)
        } else if (action === "stop" || action === "quit-browser") {
          root.activeSink = ""
          root.statusActive = false
          root.statusBusy = false
          root.statusClass = "idle"
          root.statusText = ""
          root.statusTooltip = "Chromecast: idle"
        }
      } else {
        root.targetRefreshError = false
        root.lastError = err !== "" ? err : (out !== "" ? out : "Chromecast action failed")
      }
      delayedRefresh.restart()
    }
  }

  component ActionRow: CursorSurface {
    id: actionRow
    property var action: null
    property int rowIndex: 0
    readonly property bool rowEnabled: action && action.enabled !== false

    hasCursor: root.cursorActive && root.focusSection === "actions" && root.actionIndex === rowIndex
    foreground: root.foreground
    implicitHeight: row.implicitHeight + Style.spacing.rowPaddingX
    opacity: rowEnabled ? 1.0 : 0.45

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      enabled: actionRow.rowEnabled
      cursorShape: actionRow.rowEnabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setActionCursor(actionRow.rowIndex)
      onClicked: root.activateAction(String(actionRow.action.kind || ""))
    }

    RowLayout {
      id: row
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(9)

      Text {
        text: actionRow.action ? String(actionRow.action.icon || "") : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: actionRow.action ? String(actionRow.action.label || "") : ""
          textFormat: Text.PlainText
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: actionRow.action ? String(actionRow.action.subtitle || "") : ""
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }

  component SinkRow: CursorSurface {
    id: sinkRow
    property var sink: null
    property int rowIndex: 0
    readonly property string sinkName: sink ? String(sink.name || "") : ""
    readonly property string sinkDisplayName: sink ? String(sink.displayName || sink.name || "") : ""
    readonly property bool rowEnabled: sink && sink.startable !== false && sink.ambiguous !== true
    readonly property bool currentSink: root.statusActive && (root.activeSink === sinkName || root.activeSink === sinkDisplayName)

    hasCursor: root.cursorActive && root.focusSection === "sinks" && root.sinkIndex === rowIndex
    current: currentSink
    foreground: root.foreground
    implicitHeight: row.implicitHeight + Style.spacing.rowPaddingX
    opacity: rowEnabled ? 1.0 : 0.45

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      enabled: sinkRow.rowEnabled
      cursorShape: sinkRow.rowEnabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setSinkCursor(sinkRow.rowIndex)
      onClicked: root.startSink(sinkRow.sink)
    }

    RowLayout {
      id: row
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(9)

      Text {
        text: ""
        color: sinkRow.currentSink ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: sinkRow.sinkDisplayName
          textFormat: Text.PlainText
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: sinkRow.currentSink
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: sinkRow.currentSink ? "Currently casting" : (sinkRow.rowEnabled ? "Start desktop mirroring" : "Ambiguous duplicate name; rename one receiver")
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
