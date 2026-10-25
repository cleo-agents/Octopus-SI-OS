# Desktop client

> **The desktop client is optional.** The Octopus runtime does not depend on
> this app. You can run it without a GUI or write a different client over the
> same interfaces, descriptors, and recorded evidence. The screens below are
> one presentation of that architecture, not required runtime components.

The [terminal client](cli.md) provides chat, tasks, results, and operator
responses against the same Home without opening this app.

The Octopus desktop client currently supports **macOS 14 and later**. Its
interaction design is inspired by the ChatGPT desktop app: a conversation,
voice controls, a sidebar, and work opened beside the conversation. It is an
Octopus client over Octopus runs, interfaces, and policy. Signing in with
ChatGPT connects a model provider; it does not make ChatGPT the runtime.

Start with [Getting started](getting-started.md) to build and set up the app.
The client is a research preview; a capability appearing in a catalog does not
mean it is installed, configured, or available to the current task.
Screenshots show a development installation, including its incomplete setups.

## Where to go

| Destination | Use it for |
| --- | --- |
| **Home** | The ongoing conversation with Octopus: text, voice calls, current activity, and widgets. |
| **Tasks** | Work grouped into Projects, reusable Agents, individual tasks, triggers, and archived tasks. |
| **Dashboard** | Inspect Topology, Registry, Worker Environments, and Movements. These views explain what is running and what crossed an interface. |
| **Inbox** | Review activity and requests that need attention, then open the associated work. |
| **Applications** | Install and configure providers, connectors, plugins, and context packages; choose where they are available. |
| **Drivers** | Install and configure the environments in which tools act: files, worktrees, browsers, desktops, containers, and remote execution. |

The avatar menu offers **Settings** and **Log out**. Log out locks local client
access and returns to the [password screen](getting-started.md#first-setup);
it does not sign out of the model provider. Unlock with your password, or
Touch ID if you enabled it. **Surfaces** controls additional views;
the primary navigation destinations stay available. Workspace views support
split panes, so a conversation and its evidence can remain visible together.

### Home: conversation, Activity, and voice

Home presents one continuing run. Use the composer for text and attachments.
Each message you send from Home also carries the client's snapshot of what
you can see - tasks with their status and last reply, triggers, projects and
Agents - inside the same message artifact, so Home can answer and propose
work concretely. It is not shown in the conversation.
Open **Activity** for the conversation and the detailed trace of its work.
Widgets can show task progress, upcoming work, or other configured sources;
their visibility and positions are client presentation choices.
Home also uses compact widgets for pictures, small tables and short visual
answers. Larger results can use several widgets. For longer text, Home can save
a text or Markdown document and open it in the right Files pane.

![Home conversation beside a Files pane showing a local client configuration](images/client/home-files.png)

Here, Files is an operator view of local configuration. Opening a file beside
Home does not automatically give the run access to it; model access still
requires the appropriate bindings and granted tools.

There are two distinct audio features:

- **Dictation** transcribes speech into the active composer. It prepares text
  locally in the client flow; transcription may call the configured provider.
  It does not submit an Octopus message until you send the text.
- **A voice call** connects the Home run through its declared voice interface.
  The controls include microphone mute, speaker output, device selection,
  transcript, and ending the call. Calls require a configured voice provider
  and microphone permission; text-provider sign-in alone is not enough.

**Settings → Voice & Audio** contains device choices, dictation settings and
dictionary, and the floating call controls used outside Home. A selectable
synthesized voice is offered only when the speech interface declares one.

**Settings → Appearance → Octopuses**, off by default, adds octopuses drawn as
ASCII glyph tiles that never stop swimming; the Home wave field stays behind
them, quieter. Each one picks its next destination in open water, away from the
others and so that together they stay spread across the screen, and steers
around the visible text, response, and composer instead of crossing them. On
Home, three monochrome octopuses swim at different depths, harder while Octopus
is thinking, rippling while it speaks. On the new-task screen, each recent task
gets one octopus in its agent's colour, brisk while its agent works and slower
while it waits or is idle. Clicking empty space sends a short wave of digits
that crumbles as it spreads and passes through the octopuses without moving
them.

When a voice call starts, the Home octopuses jet away from the orb toward the
nearest edge and dissolve, while the waves gather into the call orb exactly as
they do without octopuses. When the call ends and the orb returns to the waves,
the octopuses swim back in from open edges one after another.

Audio remains part of the artifact contract: microphone or speech interfaces
produce audio or transcript artifacts; receiving interfaces decide how to
play or interpret them. An audio artifact can reference binary media without
turning its contents into JSON. The kernel does not decode audio.

### Tasks: Project → Agent → task

Project settings include **Source folders**. Add several folders, remove a folder,
or use **Make primary** to choose the working directory. Tasks created afterward
use that Primary folder and can work in the other selected folders within their
configured access. **Full access** keeps those folders as working context and
uses its separately selected filesystem permissions.

Filesystem tools require a working folder from the selected project, Agent or
host configuration. When none is configured, the composer explains the missing
folder before submission; changing access settings remains available.

If a manual message cannot be sent, its text returns to the composer and the
usual error notification explains the failure. Delivery with a lost confirmation
is checked against task history; retrying explicitly uses the same message
identity. A newer draft is preserved while the failed message remains available.


A **Project** supplies the goal and permission boundary. An **Agent** is a
reusable worker template in that project: its pin, capability ceiling, and
defaults for authoring a task. Creating an Agent does not start work. A **task**
is a run created from that template; subsequent messages continue that run.

For example, to work on a repository:

1. Choose the Project and configure its source folders and Drivers.
2. Use **Create agent**, select an offered model, and review capabilities.
3. Select that Agent in the task composer and describe the change.
4. Inspect the resulting files, tool trace, and changes before accepting them.

A workspace Driver operates in the chosen folder. A worktree Driver supplies a
separate Git worktree. Choose according to where the work should happen;
creating a task does not itself promise branch isolation.

Task environment panels can expose files, a terminal, changes, a browser,
desktop, or connection details. The available panels come from the task's
actual environment. **Triggers** and **Archived** are views within Tasks.
Triggers are presented by the client over declared runtime interfaces: a time,
an interval, or a quiet period in your work, each starting an ordinary run.

![Tasks with Projects, Agents, task history, and the new-task composer](images/client/tasks.png)

### Following the evidence

**Inbox** can lead from a recorded mark to its movement. For example,
`tool.call.allowed` records permission for a call, not proof that the tool
finished successfully. **Dashboard → Movements** shows the route, artifact,
and delivery evidence; [Topology](architecture.md#the-desktop-client)
shows how the environments, runs, and interfaces connect. These are views of
the same system, not separate client histories.

![Inbox showing a recorded tool.call.allowed mark and its View movement action](images/client/inbox.png)

See the [movement and metadata example](contracts/LEDGER_INDEX.md#reading-a-movement-in-the-client).

**Dashboard → Worker Environments** lists the rooms where work touches the
world: a browser session, a Git worktree, a terminal, a desktop. Tabs separate
rooms opened for tasks, rooms opened for Home, and the system rooms Octopus
opens for its own upkeep. Each row shows what the room is, which task uses it,
whether it is open, and when it was last active; opening a row shows the room
live, its changes, or its files.

## Applications, Drivers, and Extensions

These are different catalogs, not three names for plugins.
Applications and Drivers package capabilities expressed by the architecture;
Extensions let you arrange and extend how the client presents your work.

| Catalog | What it adds | Example |
| --- | --- | --- |
| **Applications** | Interface or context packages a run can use. The catalog groups AI Providers, Connectors, Plugins, and Context. | A model provider, the Slack connector, an MCP server plugin. |
| **Drivers** | Worker-environment kinds, their doors, and tools. They supply the room where effects happen. | A browser session or a Git worktree. |
| **Settings → Extensions** | Client widgets, tabs/panels, inputs, and guided repairs. Their declared sources and actions are reviewed during setup. | A Home widget, an additional workspace view, or Smart gestures. |

In architecture documents, *driver* also means the implementation behind any
interface, including a provider. The **Drivers** screen specifically presents
worker environments. Neither use means a macOS kernel extension.
For concrete catalog examples, see [Applications](contracts/EXTENSION_SURFACES.md#in-the-client)
and [Drivers](contracts/ENVIRONMENTS.md#in-the-app).

Installation and access are separate:

1. **Install** materializes the package and its required dependencies.
2. **Configure** supplies the required account, endpoint, device, or folder.
3. **Make available** admits it within Home or the chosen Project's ceiling.
4. **Select/connect** gives a task the relevant bindings. A default for new
   tasks is not evidence that an existing task already uses it.

An installed package grants no authority by itself. Each card shows one
status: **Not installed**, **Needs setup** (details such as an API key are
missing), **Not enabled** (installed but not yet available in Home or a
project), **Enabled**, **Needs repair** or **Check settings**, followed by how
many tasks are connected. Removal can be blocked while live records depend on
it.

### Client Extensions

Open **Settings → Extensions** to browse and manage additions to the client:

- **Widgets** add focused views to Home, such as **Live context**, **Task
  progress**, or **Memory** with a selected knowledge folder such as an Obsidian
  vault.
- **Tabs** add workspace views, including **Metrics** and **Codex Usage**.
- **Inputs** add ways to control the client. **Smart gestures** connects a
  decision model through your own OpenRouter key so hand movement can be read
  as intent rather than as a fixed pose list.
- **Repairs** provide explicit maintenance actions, such as **Codex sign-in
  check** after an authentication failure.

Review an extension's declared sources and actions before installing it, then
complete any required setup. Adding a client view does not grant a run new
tools or access to data.

Some extensions need a key. A key is a credential source: the manifest names
the one origin it may be sent to, setup stores it with owner-only file
permissions in the Home's `client/extensions/credentials`, and the client page
and Home never read it back. **Check** asks that origin whether it still
accepts the key. An input's model call is client presentation work, like
speech recognition; it is not a provider binding and gives no run access.

An extension's source is client configuration, not an interface binding. For
example, selecting an Obsidian vault for **Memory** gives that widget a folder
to display; it does not create a runtime memory module or bind the vault to a
task. **Metrics** similarly presents existing evidence rather than creating
another event log.

![Extensions catalog with Home widgets, workspace tabs, and guided repairs](images/client/extensions.png)

Custom Extensions are files too. **Open folder** opens the extension root,
`<home>/client/extensions`; packages live at `packages/<id>/extension.json` and
follow the [manifest schema](../app/schemas/client_extension_manifest.schema.json).
Custom views use the [surface document contract](../app/client-surfaces/README.md)
for native components or sandboxed HTML/CSS/JavaScript; no new kernel feature
is needed.

You can ask Home for one in plain words - "show me X on Home and keep it
updated", "add a tab with Y". Home first asks the running client what it can
host (`inspect_client`): the folder, the exact schemas this build accepts,
targets, components, data sources, and every Extension's state. It then writes
the package with its ordinary file tools and, when the view needs data nothing
projects yet, the system side in the same task - for example a small feed
interface and the run that emits into it on a trigger. The client discovers the
new package, validates it, and asks you to review its exact revision wherever
you are; it does not silently run new code. After you install it, it goes live
without a restart. Refusals, setup gaps, and errors the view hits while
rendering go back to Home through the same inspection, so it can fix them; each
fix is a new revision you review again.

Showing, hiding or removing widgets you already have is simpler: Home lists
them and changes any number of them in one request. The client applies the
change at once and reports the actual state back when Home's turn ends, and
Home continues from it. Stop ends the whole request: nothing Home asked for in
the stopped turn is applied afterwards, and no reply about it follows.

Extensions are additions you install and remove. They are not the only way to
change the client: the client is ordinary code, and Home, which holds your
machine's rights in the default setup, can change any part of it. Ask for it in
plain words; Home finds the client's source, edits it, rebuilds it and asks the
running client to relaunch. The system keeps running while the client
restarts, even when it was started from the client's own launch terminal, so
Home's work continues; you sign in again and the change is there. Quitting the
client yourself still stops a system it launched.

### Where packages come from

**Today the app uses a local package library, not a hosted marketplace.** The
source and delivery path is:

```text
repository registry/ + app/distribution/local-packages/
    → packaging: startup baseline + local package library inside Octopus.app
    → Install: selected package files and receipts in the chosen Home
    → project/task setup: explicit descriptor and binding changes
```

During source development, the library resolves to the checkout. A packaged
app uses the copy bundled inside it. Clicking Install materializes those local
files; it does not fetch a newer Driver from an Octopus server. Building the
app can download dependencies, and an installed integration can contact its
external service during use. Those are separate network operations.

Client Extensions have their own built-in catalog and a local package directory
in the selected Home's `client/extensions`. This is separate from the runtime registry.
The current client has no hosted Extension marketplace or automatic app
updater. A new build supplies a new bundled library; local Home changes still
need to be reconciled through the package lifecycle.

To add a capability, start with [Extending Octopus](contracts/EXTENSION_SURFACES.md).
To understand updates and local JSON changes, read
[Source and Home](development.md#source-and-home).

## Experimental interaction and Test

**Settings → Gestures** maps camera-recognized hand gestures to client
commands. It includes camera selection, built-in mappings, custom gesture
recording, and a preview. Camera access is required. Treat these controls as
experimental, particularly across different cameras and lighting.

A swipe is a quick sideways flick with an open hand or two fingers; by default
left goes Back and right goes Forward. It is judged by the hand's speed and
straightness, so a frame lost to motion blur or a hand leaving the camera at
speed still counts, slow sideways movement steps gesture focus instead, and the
hand returning after a swipe is not read as a swipe the other way. Held poses
fire only while the hand stays still. While Settings is open, the preview names
each recognized gesture and its command, and commands run once Settings is
closed. The preview also measures how many frames per second the camera really
delivers and warns when that is too few for swipes; a dim room or a phone used
as a camera can drop to a handful.

These gestures are client input, like keyboard shortcuts. The camera recognizer
emits a local event, which selects a client command or moves a Home widget.
Switching a tab or dragging a widget does not send an artifact through the
runtime. If a command submits a message or starts a call, that action enters
the ordinary chat or voice interface path.

The repository also carries [AirHand](../registry/interface/world_hand_gesture_control/README.md),
a macOS prototype for moving the pointer, clicking, and scrolling from a
camera. Desktop input requires Accessibility permission as well as Camera
permission. Its experimental `world_hand_gesture_control` bridge can report
gesture/tracking events to a bound run and accept commands to start recognition,
read status, or calibrate AirHand. The current client does not launch this
native app or use its bridge, and the shipped setup supplies no gesture-to-agent
run binding. Using that integration requires the separate app and an explicitly
authored binding. Native pointer control stays in AirHand's own process.

**Test** is a separate client access profile, not another name for Tasks.
Its **Test Lab** settings expose fixtures, synthetic voice activity, and
surface previews. It has no live runtime or endpoint authority. A successful
Test preview does not prove a real model call, tool execution, or device setup.

Test shows the same screens as the live client. Its Applications, Drivers,
Application Packs, and provider models come from the package library bundled
with the app, with a fixed set marked installed; it never reads the Home's
registry. Its runtime status is the isolated lab's own, never the probe of the
Home's runtime. Tasks, transcripts, triggers, and worker environments are fixtures in
the current projection shapes. Built-in Home widgets that install by default
are shown, and the Extensions catalog is read-only. Sending a message, steering,
pinning, and editing a trigger are simulated in memory.

Registry and Files open a **Test Home** with two folders: `registry/` is the
bundled package library, read-only, plus a descriptor for each interface the
lab projects; `workspace/` is the demo project the simulated task edits, and
saving there changes only the lab's memory. Opening an artifact shows its
fixture payload as JSON. Attachment bytes and voice recordings are not kept in
Test, and nothing in Test can be revealed or opened on the Mac.

For custom UI, [client surface documents](../app/client-surfaces/README.md)
describe small widgets and workspace views as validated JSON. Test can watch
local documents; Administrator reads stable documents from runtime projection
evidence. A client widget cannot grant itself tool or runtime access.

## Cost and local data

Octopus is MIT-licensed and has no paid Octopus tier in this preview. You supply
the model/provider access. Account limits, API charges, voice services, remote
compute, and other connected services remain those providers' costs. There is
no single per-task price: it depends on the selected model and work performed.

The **Home screen** is a conversation. The **Home directory**, normally
`~/.octopus`, is the private state of an installation: its active registry,
runs, ledger, and interface data. The client keeps its preferences and
Extensions in that Home's `client/` directory. The launch selection and
provider authentication live elsewhere, such as Codex credentials under
`~/.codex`, so changing `OCTOPUS_HOME` alone does not isolate provider accounts.

Use **Settings → About & Diagnostics** for build facts, Doctor, and client logs.
See [Troubleshooting](../TROUBLESHOOTING.md) before sharing a report or changing
an installation that fails. Read the [security model](security-model.md) when
granting new capabilities.
