import SwiftUI

private enum WatchStyle {
  // T3 Code dark-theme accent; system text and controls adapt to accessibility settings.
  static let accent = Color(red: 52 / 255, green: 107 / 255, blue: 241 / 255)
}

struct WatchHomeView: View {
  @ObservedObject var model: WatchModel
  @Environment(\.dynamicTypeSize) private var typeSize

  private var destinationLayout: AnyLayout {
    typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(spacing: 12))
      : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 10) {
          if !model.notice.isEmpty { NoticeView(text: model.notice) }
          CaptureControls(model: model, thread: nil, home: true)
          destinationLayout {
            NavigationLink {
              WatchRecordingsView(model: model)
            } label: {
              HomeDestination(title: "Audio", symbol: "waveform", total: model.recordings.count)
            }
            NavigationLink {
              WatchThreadsView(model: model)
            } label: {
              HomeDestination(title: "Threads", symbol: "bubble.left.and.bubble.right", total: model.threads.count)
            }
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
      }
      .navigationTitle("")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { WatchBrandTitle() }
      }
      .tint(WatchStyle.accent)
      .alert("Could not record", isPresented: Binding(get: { model.captureError != nil }, set: { if !$0 { model.captureError = nil } })) {
        Button("OK", role: .cancel) { model.captureError = nil }
      } message: {
        Text(model.captureError ?? "Try recording again.")
      }
      .sheet(isPresented: Binding(get: { model.recordingID != nil }, set: { if !$0 { model.stopRecording() } })) {
        RecordingSessionView(model: model)
          .interactiveDismissDisabled()
      }
    }
  }
}

private struct WatchBrandTitle: View {
  @ScaledMetric(relativeTo: .headline) private var markHeight = 13

  private var mark: some View {
    Image("T3Wordmark")
      .renderingMode(.template)
      .resizable()
      .scaledToFit()
      .frame(width: markHeight * 94.3941 / 56.96, height: markHeight)
      .foregroundStyle(Color.primary)
      .accessibilityHidden(true)
  }

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 4) {
        mark
        Text("Code")
          .font(.headline.weight(.medium))
          .tracking(-0.4)
          .foregroundStyle(Color.secondary)
      }
      mark
    }
    .tint(Color.primary)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("T3 Code")
    .accessibilityAddTraits(.isHeader)
  }
}

private struct HomeDestination: View {
  let title: LocalizedStringKey
  let symbol: String
  let total: Int

  var body: some View {
    VStack(spacing: 3) {
      Image(systemName: symbol).font(.title3)
      Text(title).font(.caption2)
    }
    .foregroundStyle(Color.primary)
    .frame(maxWidth: .infinity, minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(title))
    .accessibilityValue(Text(total, format: .number))
  }
}

private struct HomeCaptureLabel: View {
  let requestingPermission: Bool
  @ScaledMetric(relativeTo: .title2) private var diameter = 64

  var body: some View {
    VStack(spacing: 6) {
      ZStack {
        Circle().fill(WatchStyle.accent)
        if requestingPermission {
          ProgressView().tint(.white)
        } else {
          Image(systemName: "mic.fill")
            .font(.system(.largeTitle, weight: .medium))
            .foregroundStyle(.white)
        }
      }
      .frame(width: diameter, height: diameter)
      Text(requestingPermission ? "Allow microphone…" : "Record")
        .font(.headline.weight(.medium))
        .foregroundStyle(Color.primary)
    }
    .frame(maxWidth: .infinity)
    .contentShape(Rectangle())
  }
}

private struct NoticeView: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel(Text(verbatim: text))
  }
}

private struct CaptureControls: View {
  @ObservedObject var model: WatchModel
  let thread: WatchThread?
  var home = false

  private var recordButton: some View {
    Button {
      model.startRecording(replyTo: thread)
    } label: {
      if home {
        HomeCaptureLabel(requestingPermission: model.requestingPermission)
      } else {
        Label(model.requestingPermission ? "Allow microphone…" : "Reply", systemImage: "mic.fill")
      }
    }
    .disabled(model.requestingPermission || !model.canRecord)
    .accessibilityLabel(model.requestingPermission ? "Allow microphone…" : home ? "Record" : "Reply")
    .accessibilityHint("Saves on Watch for review on iPhone. Does not send a message.")
    .accessibilityIdentifier("capture.start")
  }

  var body: some View {
    if model.recordingID != nil {
      Button("Stop and save", systemImage: "stop.fill") { model.stopRecording() }
        .tint(.red)
        .accessibilityIdentifier("capture.stop")
    } else if home {
      recordButton.buttonStyle(.plain)
    } else {
      recordButton.buttonStyle(.borderedProminent)
    }
  }
}

private struct RecordingSessionView: View {
  @ObservedObject var model: WatchModel

  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        Label("Recording", systemImage: "record.circle.fill")
          .font(.headline)
          .foregroundStyle(.red)
        Text(Duration.seconds(model.elapsed), format: .time(pattern: .minuteSecond))
          .font(.largeTitle.monospacedDigit())
          .accessibilityLabel("Elapsed time")
          .accessibilityValue("\(model.elapsed) seconds")
          .accessibilityHint("Stops automatically after three minutes.")
        RecordingControl(model: model)
        if let title = model.recordingTitle {
          Text(title).font(.footnote).multilineTextAlignment(.center)
        }
      }
      .padding(.horizontal)
    }
  }
}

private struct RecordingControl: View {
  @ObservedObject var model: WatchModel

  var body: some View {
    HStack(spacing: 12) {
      VoiceLevelView(meter: model.audioMeter)
        .frame(maxWidth: .infinity)
      Button { model.stopRecording() } label: {
        Image(systemName: "stop.fill")
          .font(.title3)
          .frame(minWidth: 44, minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop and save recording")
      .accessibilityIdentifier("capture.stop")
    }
    .padding(.leading, 16)
    .padding(.trailing, 4)
    .padding(.vertical, 4)
    .background(.quaternary, in: Capsule())
    .overlay { Capsule().strokeBorder(.secondary.opacity(0.35), lineWidth: 1) }
  }
}

private struct VoiceLevelView: View {
  @ObservedObject var meter: WatchAudioMeter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack(alignment: .center, spacing: 5) {
      ForEach(meter.levels.indices, id: \.self) { index in
        RoundedRectangle(cornerRadius: 3)
          .fill(WatchStyle.accent.opacity(0.35 + meter.levels[index] * 0.65))
          .frame(width: 5, height: reduceMotion ? 5 : 5 + meter.levels[index] * 23)
      }
    }
    .frame(height: 30)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: meter.levels)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Microphone level")
    .accessibilityValue((meter.levels.max() ?? 0) > 0.08 ? "Sound detected" : "Quiet")
  }
}

private struct WatchRecordingsView: View {
  @ObservedObject var model: WatchModel

  var body: some View {
    List {
      if model.recordings.isEmpty {
        Section {
          Label("No recordings", systemImage: "waveform")
            .font(.headline)
        }
      } else {
        Section {
          ForEach(model.recordings.reversed(), id: \.id) { recording in
            NavigationLink {
              WatchRecordingView(model: model, recording: recording)
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                WatchDateLabel(value: recording.createdAt).font(.headline)
                if recording.kind == "reply" {
                  Label("Reply", systemImage: "arrowshape.turn.up.left")
                    .font(.caption).foregroundStyle(.secondary)
                }
                Text(model.recordingStatus(recording.id)).font(.footnote)
              }
            }
          }
        }
        Section {
          Button("Retry sending", systemImage: "arrow.clockwise") { model.refreshAndTransfer() }
          if model.recordings.count >= RecordingStore.maximumRecords - 8 {
            Text("\(model.recordings.count) of 32 on Watch")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }
      }
      if !model.notice.isEmpty { Section { NoticeView(text: model.notice) } }
    }
    .navigationTitle("Recordings")
  }
}

private struct WatchRecordingView: View {
  @ObservedObject var model: WatchModel
  let recording: WatchRecording
  @State private var confirmDeletion = false

  var body: some View {
    List {
      if model.recordings.contains(where: { $0.id == recording.id }) {
        Section {
          VStack(alignment: .leading, spacing: 4) {
            WatchDateLabel(value: recording.createdAt).font(.headline)
            if recording.kind == "reply" {
              Label("Reply", systemImage: "arrowshape.turn.up.left")
                .font(.footnote).foregroundStyle(.secondary)
            }
            Text(model.recordingStatus(recording.id)).font(.footnote)
          }
        }
        if recording.id != model.recordingID {
          Section {
            Button(model.playingID == recording.id ? "Stop" : "Play", systemImage: model.playingID == recording.id ? "stop.fill" : "play.fill") {
              if model.playingID == recording.id { model.stopPlayback() } else { model.play(recording) }
            }
            .disabled(model.recordingID != nil)
            .accessibilityIdentifier("recording.playback")
            Button("Delete…", role: .destructive) { confirmDeletion = true }
              .accessibilityIdentifier("recording.delete")
          }
        }
      } else {
        NoticeView(text: "Removed from Watch. Check the iPhone inbox.")
      }
      if !model.notice.isEmpty { Section { NoticeView(text: model.notice) } }
    }
    .navigationTitle("Recording")
    .onDisappear { model.stopPlayback() }
    .confirmationDialog("Delete this recording from Watch?", isPresented: $confirmDeletion, titleVisibility: .visible) {
      Button("Delete recording", role: .destructive) { model.discard(recording) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This cannot be undone. A copy already received on iPhone will remain there.")
    }
  }
}

private struct WatchThreadsView: View {
  @ObservedObject var model: WatchModel

  var body: some View {
    List {
      if model.threads.isEmpty {
        VStack(spacing: 8) {
          Image(systemName: "bubble.left.and.bubble.right").font(.title2)
          Text("No threads").font(.headline)
          NoticeView(text: "Enable Watch sync in T3 Code on iPhone.")
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .listRowBackground(Color.clear)
      } else {
        Section {
          ForEach(model.threads, id: \.bindingID) { thread in
            NavigationLink {
              WatchThreadView(model: model, environmentId: thread.environmentId, threadId: thread.id)
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(thread.title).font(.headline).lineLimit(3)
                Text(thread.projectTitle).font(.caption).foregroundStyle(.secondary)
                ThreadStatusView(thread: thread)
              }
            }
          }
        } header: {
          Text("Last synced from iPhone")
        }
      }
    }
    .navigationTitle("Threads")
  }
}

private struct WatchDateLabel: View {
  let value: String

  var body: some View {
    if let date = WatchDate.parse(value) {
      Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
    } else {
      Text("Date unavailable")
    }
  }
}

private struct ThreadStatusView: View {
  let thread: WatchThread

  private var label: LocalizedStringKey {
    if thread.pendingRequest != nil { return "Needs review on iPhone" }
    switch thread.status {
    case "running", "starting", "preparing": return "Working"
    case "queued": return "Queued"
    case "waiting": return "Waiting"
    case "idle": return "Idle"
    case "settled", "done": return "Done"
    case "error", "failed": return "Needs attention"
    default: return "Status unavailable"
    }
  }

  var body: some View {
    Label(label, systemImage: thread.pendingRequest != nil ? "iphone" : "clock")
      .font(.footnote)
      .foregroundStyle(.secondary)
  }
}

private struct WatchThreadView: View {
  @ObservedObject var model: WatchModel
  let environmentId: String
  let threadId: String
  private var thread: WatchThread? {
    model.threads.first { $0.id == threadId && $0.environmentId == environmentId }
  }

  var body: some View {
    List {
      if let thread {
        Section {
          VStack(alignment: .leading, spacing: 6) {
            Text(thread.title).font(.headline)
            Text(thread.projectTitle).font(.footnote).foregroundStyle(.secondary)
            ThreadStatusView(thread: thread)
            WatchDateLabel(value: thread.updatedAt).font(.caption).foregroundStyle(.secondary)
              .accessibilityLabel("Thread last updated")
          }
        }
        Section {
          CaptureControls(model: model, thread: thread)
        }
        if let request = thread.pendingRequest {
          Section {
            Text(request.title).font(.headline)
            Button("Review on iPhone", systemImage: "iphone") {
              model.requestAction(request.kind == "approval" ? "approval" : "answer", thread: thread, reviewOnPhone: true)
            }
            .disabled(model.actionPending)
          }
        }
        Section {
          Button("Mark done…", systemImage: "checkmark") { model.requestAction("settle", thread: thread) }
            .disabled(model.actionPending)
          Button("Reopen…", systemImage: "arrow.uturn.backward") { model.requestAction("reopen", thread: thread) }
            .disabled(model.actionPending)
        } footer: {
          Text("Confirm on iPhone.")
        }
      } else {
        NoticeView(text: "Thread unavailable. Open T3 Code on iPhone.")
      }
      if !model.notice.isEmpty { Section { NoticeView(text: model.notice) } }
    }
    .navigationTitle("Thread")
  }
}
