# Sankey Flow

An open-source Obsidian plugin for creating interactive Sankey diagrams whose nodes link to your existing notes. Build diagrams visually, connect any node or flow to a note, heading or block in your vault, import Markdown tables and CSV files, and embed diagrams anywhere Markdown renders — reading view, Live Preview, transclusions, hover previews and Canvas.

Diagrams are ordinary Markdown notes in your vault. They sync, version and back up like everything else, and the notes they link to show up in backlinks and the graph.

---

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [The editor](#the-editor)
- [Embedding diagrams](#embedding-diagrams)
- [Linking nodes to notes](#linking-nodes-to-notes)
- [Importing tables and CSV](#importing-tables-and-csv)
- [Commands](#commands)
- [Settings](#settings)
- [File format](#file-format)
- [Compatibility](#compatibility)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Installation

Until the plugin is listed in Community plugins, install it manually:

1. Build it (see [Development](#development)) or take `main.js`, `manifest.json` and `styles.css` from a release.
2. Create the folder `<your vault>/.obsidian/plugins/sankey-flow/` and copy the three files into it.
3. In Obsidian, open **Settings → Community plugins**, reload the list and enable **Sankey Flow**.

Requires Obsidian 1.7.2 or later. Works on desktop and mobile.

## Quick start

1. Open the command palette and run **Sankey Flow: Create new diagram**.
2. Enter a name. The diagram opens in the editor.
3. In the **Flows** table at the bottom right, type a source, a target and a value (for example `Coal`, `Electricity`, `50`) and press Enter. Nodes are created automatically.
4. Add more flows the same way. The diagram updates as you type and saves automatically.
5. In any note, run **Sankey Flow: Insert diagram into current note**, or type `![[Your diagram name]]`.

To explore every feature at once, copy the [`examples`](examples) folder into a vault: it contains a diagram note, a note with a table and inline and embedded diagrams, linked notes, and a CSV file with deliberately awkward formatting.

## The editor

The diagram takes most of the space; a sidebar on the right (below on narrow windows) has four tabs:

| Tab | What it does |
|---|---|
| **Flows** | Spreadsheet of all flows: edit source, target and value inline, sort by any column, search, duplicate or delete rows, import or export CSV. Large tables are virtualised. |
| **Nodes** | All nodes in stacking order. Click to select, double-click or F2 to rename, use the arrows or Alt+↑/↓ to reorder. |
| **Inspect** | Edit the selected node or flow: name, link, group, description, colour, value, label, connections, and quick "add outgoing flow". |
| **Diagram** | Title, description, alignment, smoothing, node width and spacing, colour modes, label and value display, number format, and embed height. |

Working directly on the diagram:

- **Select**: click a node or flow. **Edit**: double-click it.
- **Move**: drag a node. Its position is pinned and remembered (stored relative to the diagram size, so it survives resizing). **Reset layout** clears pinned positions.
- **Connect**: hover a node and drag from the small circle on its right edge to another node. Drop on empty space to create a new connected node there.
- **Open a link**: Ctrl/Cmd-click a linked node or flow. Hover with Ctrl/Cmd for Obsidian's page preview.
- **Context menu**: right-click a node, flow or the background.
- **Zoom and pan**: Ctrl/Cmd + scroll zooms, scrolling pans (configurable), drag the background to pan, pinch on touch screens, double-click the background to fit.
- **Keyboard** (when the diagram has focus): arrow keys move between nodes, Enter edits, Delete removes, Escape clears the selection, `+`/`-` zoom, `0` fits, Shift+F10 opens the context menu. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) undo and redo while the editor is active; inside text fields they keep their normal text behaviour.

Everything is undoable: creating, deleting, moving, renaming, recolouring, value changes, imports and layout changes. Rapid typing in one field collapses into a single undo step.

**Saving.** Changes are written about a second after you stop editing (configurable). If the file changes outside the editor — another device via Sync, Git, a text edit — the editor reloads it automatically. If you also have unsaved edits at that moment, autosave pauses and you choose **Keep my version** or **Load the other version**; nothing is overwritten silently. If you close the tab with that choice still open, your version is saved as a separate "conflicted copy" note.

**Open as Markdown.** Diagram notes open in the editor. Use the page icon in the tab header (or the command **Open diagram data as Markdown**) to see the note itself; that tab stays in Markdown until it opens another file.

## Embedding diagrams

There are three ways to show a diagram in a note:

**1. Embed the diagram note** (recommended — it is indexed, so the diagram lists the note as a backlink):

```markdown
![[Energy flow]]
```

**2. Reference it from a code block**, which lets you override options per embed:

````markdown
```sankey-flow
diagram: [[Energy flow]]
height: 420
title: false
```
````

**3. Write flows inline** for quick, one-off diagrams:

````markdown
```sankey-flow
height: 300
suffix: TWh
Coal -> Electricity: 50
Gas -> Electricity: 30
Electricity [60] Homes
Electricity [20] Industry
:Electricity #c0a050
```
````

Both `Source -> Target: value` and SankeyMATIC's `Source [value] Target` are accepted. `→` and `=>` work as arrows, `//` and `%%` start comments, and `:Node #colour` colours a node. Wikilinks in names (`[[Coal]] -> Electricity: 50`) become linked nodes. Use **Save as diagram file** in the block's toolbar to turn inline flows into an editable diagram note; the block is replaced by an embed.

Code block options:

| Option | Example | Meaning |
|---|---|---|
| `diagram` | `[[Energy flow]]` | Diagram note to show. |
| `height` | `420` | Height in pixels (120–4000). |
| `title` | `My caption` / `false` | Caption text, or hide the title. |
| `align` | `left` | `justify`, `left`, `right` or `center`. |
| `values` | `false` | Show or hide values. |
| `prefix`, `suffix` | `$`, `TWh` | Value formatting. Word units get a space (`50 TWh`); quote a value to keep it exact (`suffix: "kg"`). |
| `unit` | `t` | Same as `suffix`. |
| `colors` | `accent` | `categorical`, `accent`, `sequential` or `custom`. |
| `query`, `source`, `target`, `value`, `label` | | Dataview integration, see below. |

`sankey` works as a shorter alias for `sankey-flow`, unless another plugin in your vault already renders `sankey` blocks (the Sankey plugin does). The plugin always writes `sankey-flow`, so diagrams keep working next to other Sankey plugins.

Embedded diagrams render in reading view, Live Preview, transclusions, hover previews and Canvas file cards. Click a linked node to open its note (Ctrl/Cmd-click for a new tab), hover for details, right-click for export options, and use the pencil icon to open the editor.

## Linking nodes to notes

Every node and flow can link to:

- a note: `[[Project Alpha]]`
- a heading: `[[Project Alpha#Budget]]`
- a block: `[[Project Alpha#^q3-figures]]`
- a canvas or attachment: `[[Board.canvas]]`, `[[report.pdf]]`
- an external URL: `https://example.com`

Type in the **Link** field of the inspector to get suggestions for notes, then headings (`Note#`) and blocks (`Note#^`). Or right-click a node and choose **Link to note…**.

Links behave like normal Obsidian links:

- Clicking opens them with Obsidian's own navigation, respecting tabs, splits and history.
- The context menu offers **Open linked note**, **Open in new tab**, **Open to the right**, **Reveal in file explorer**, **Copy Obsidian link** and **Remove link**.
- Every linked note is mirrored into the diagram note's `sankey-links` property, so Obsidian indexes it: the linked note shows the diagram in its **backlinks**, the **graph view** shows the connection, and outgoing links work.
- When a linked note is renamed or moved, the diagram's links are updated. When a diagram is renamed, `diagram:` references in code blocks are updated too (both can be turned off in settings).

## Importing tables and CSV

**From a Markdown table.** Put the cursor inside a table and run **Create diagram from current table** (also in the editor's right-click menu). Any column names work: you choose which column is Source, Target and Value (and optionally a Label). Common names such as `From`/`To`/`Amount` are recognised automatically. Wikilinks in cells become linked nodes. You can insert an embed of the new diagram right below the table.

**From CSV.** Run **Create diagram from CSV**, pick a `.csv` file from the vault or from your computer (you can also right-click a CSV file in the file explorer, or drop a file onto the import dialog). The dialog then:

1. detects the delimiter (comma, semicolon, tab or pipe) and whether there is a header row,
2. previews the rows with the mapped columns highlighted,
3. lets you map columns and choose the number format (`1,234.5` or `1.234,5`),
4. shows a live preview of the diagram,
5. explains every row that will be skipped, for example *Row 5: "oops" in Amount is not a number*,
6. creates the diagram when you confirm.

Rows with the same source and target can be combined (summed). Use **Import CSV…** in the editor to add flows to an existing diagram or replace its data.

**From Dataview (experimental, optional).** If the Dataview plugin is installed, a `sankey-flow` block can run a `TABLE` query:

````markdown
```sankey-flow
query: TABLE from AS Source, to AS Target, amount AS Value FROM "Finance"
source: Source
target: Target
value: Value
```
````

Indented lines continue a long query. Links returned by Dataview become linked nodes, and the diagram refreshes when Dataview's index changes. Without Dataview, such blocks show an explanatory message; everything else is unaffected.

## Commands

All commands are available in the command palette. None has a default hotkey, so nothing collides with your existing shortcuts; assign your own under **Settings → Hotkeys**.

| Command | Available |
|---|---|
| Create new diagram | always |
| Open diagram… | always |
| Open diagram manager | always (also the ribbon icon) |
| Create diagram from current table | in a Markdown editor |
| Create diagram from CSV | always |
| Insert diagram into current note | in a Markdown editor |
| Edit current diagram | in a diagram note, or with the cursor in a `diagram:` code block |
| Refresh diagrams | always |
| Open diagram data as Markdown | in the editor |
| Export current diagram as SVG / PNG / CSV / JSON | in the editor |
| Import CSV into current diagram | in the editor |
| Add node, Undo diagram change, Redo diagram change | in the editor |
| Focus diagram, Fit diagram to view, Zoom in, Zoom out, Reset layout, Save diagram now | in the editor |

The **diagram manager** (ribbon icon) lists every diagram with search and sorting. From there you can open, rename (links are updated by Obsidian), duplicate, delete (to the trash, after confirmation) and see which notes reference a diagram.

## Settings

Sensible defaults are applied, so nothing needs configuring before first use.

- **General**: diagram folder, open diagram notes in the editor, autosave and its delay, default layout, default embed height, insert style (embed link or code block), update links on rename, ribbon icon.
- **Appearance**: node colour mode (categorical, accent shades, sequential, custom), flow colour mode (from source, from target, gradient, neutral), accent colour, default node and flow colours, custom palettes for light and dark mode, flow and highlight opacity, node width, spacing, corner radius and borders, labels, values, animations.
- **Interaction**: zoom behaviour in the editor and in notes, panning in notes, tooltips, hover highlighting, what clicking a linked node in a note does.
- **Import and export**: CSV delimiter, number format, column names recognised automatically, combining duplicate flows, export folder, PNG resolution, export background.
- **Performance**: large-diagram threshold (above it animations and gradients are off, fewer layout passes run, and labels of tiny nodes are hidden) and default layout smoothing.
- **Advanced**: Dataview queries, debug logging, schema version.

Each diagram can override colours, labels, values, number format, node sizes and embed height in its **Diagram** tab. Anything left at "Default" follows these settings.

**Colours.** Automatic colours are CSS expressions built on your theme's variables (`--interactive-accent`, `--color-blue`, `--background-primary`, …), softened slightly towards the background. They follow light and dark mode and community themes instantly. Quick colour picks in the inspector are stored as theme variables too; a custom colour is stored as hex.

## File format

A diagram is a Markdown note:

````markdown
---
sankey-flow: diagram
sankey-links:
  - "[[Coal]]"
  - "[[Grid#Overview]]"
tags:
  - energy
---

```sankey-flow
{
  "type": "sankey-flow",
  "version": 1,
  "meta": { "title": "Energy flow", "description": "", "created": "2026-10-08T09:00:00.000Z", "modified": "2026-10-08T09:30:00.000Z" },
  "nodes": [
    {"id":"coal","label":"Coal","link":"[[Coal]]"},
    {"id":"electricity","label":"Electricity","color":"var(--color-green)","link":"[[Grid#Overview]]"},
    {"id":"homes","label":"Homes","position":{"x":1,"y":0.15}}
  ],
  "flows": [
    {"id":"f-1a2b3c","source":"coal","target":"electricity","value":50},
    {"id":"f-4d5e6f","source":"electricity","target":"homes","value":41,"label":"Residential"}
  ],
  "display": { "valueSuffix": " TWh" },
  "layout": { "align": "justify", "iterations": 6 },
  "extensions": {}
}
```

Anything you write below the diagram is kept.
````

**Why a Markdown note and not a `.sankey` file?** Obsidian can only embed, preview, index and show in Canvas the file types it understands. A custom `.sankey` extension would not render with `![[…]]` in Live Preview or Canvas, and the links inside it would be invisible to backlinks and the graph. Storing the data in a Markdown note keeps all of that working with Obsidian's public API alone, while the data stays plain, readable JSON. Exported `.sankey.json` files contain just the JSON document.

What Sankey Flow writes:

- Only the `sankey-flow` and `sankey-links` frontmatter keys and the data block are ever changed. Other properties, and any text around the block, are preserved byte for byte.
- One node or flow per line, so Git diffs stay small and readable.
- A longer code fence is used automatically if a label contains backticks.
- Data blocks written as ```` ```sankey ```` (early development builds) are read normally and rewritten as ```` ```sankey-flow ```` the next time the diagram is saved.

### Schema (version 1)

| Field | Type | Notes |
|---|---|---|
| `type` | `"sankey-flow"` | |
| `version` | integer | Schema version. Files with a newer version are never opened for editing or overwritten. |
| `meta.title`, `meta.description` | string | |
| `meta.created`, `meta.modified` | ISO 8601 string | Optional. |
| `nodes[].id` | string | Unique within the diagram. |
| `nodes[].label` | string | Display name. |
| `nodes[].color` | CSS colour | Optional. Hex, `rgb()`, `hsl()`, named colours or `var(--…)`. Anything that could load external resources is rejected. |
| `nodes[].group` | string | Optional category (categorical colouring). |
| `nodes[].description` | string | Optional, shown in tooltips. |
| `nodes[].link` | string | Optional wikilink or http(s)/mailto/obsidian URL. |
| `nodes[].position` | `{x, y}` in 0–1 | Optional pinned position, relative to the diagram area. |
| `flows[].id` | string | Unique within the diagram. |
| `flows[].source`, `flows[].target` | node id | |
| `flows[].value` | number | Drawn when finite and greater than zero. |
| `flows[].label`, `description`, `color`, `link` | | Optional, as for nodes. |
| `display` | object | Optional overrides: `colorMode`, `flowColorMode`, `showLabels`, `showValues`, `valuePrefix`, `valueSuffix`, `decimals`, `nodeWidth`, `nodePadding`, `height`. |
| `layout.align` | `justify` \| `left` \| `right` \| `center` | |
| `layout.iterations` | 0–32 | Relaxation passes of the automatic layout. |
| `extensions` | object | Reserved for other tools, namespaced by id (`{"my-plugin": {…}}`). |

**Compatibility rules.** Unknown properties at any level are preserved when a diagram is loaded and saved. Unversioned data in the common D3 shape (`{ nodes: [{name}], links: [{source: 0, target: 1, value}] }`, endpoints as indices, ids or names) is converted on load. Recoverable problems — duplicate ids, flows pointing at missing nodes, non-numeric values — are repaired in memory and listed in the editor; nothing is written until you edit. Invalid JSON is reported with its position and never overwritten.

## Compatibility

- **Themes**: all colours come from Obsidian's CSS variables, and the plugin follows light/dark mode and theme changes immediately. All CSS is namespaced under `.sankey-flow-*`; nothing global is changed.
- **Hotkeys**: none are registered by default. Editor shortcuts (undo/redo, arrows, Delete) only act while the diagram or editor is focused, and never inside text fields.
- **Other plugins**: no dependencies and no monkey-patching. Dataview is detected optionally. Diagram notes are normal notes, so Templater, QuickAdd, Git, Sync, search and properties all work with them. Canvas shows diagram notes in file cards.
- **Large vaults**: diagrams are discovered through Obsidian's metadata cache, without reading files. Code-block references are indexed lazily and kept up to date from the metadata cache's change events.
- **Large diagrams**: the layout handles hundreds of nodes and thousands of flows (3,000 flows lay out in well under a second in the test suite). Above the configurable threshold, the renderer drops animations and gradients and hides labels of very small nodes.
- **Mobile**: diagrams and embeds render and respond to touch (tap, pinch to zoom in the editor, page scrolling stays normal in embeds). The editor works but is best on larger screens; on phones the sidebar starts collapsed.
- **Accessibility**: diagrams are keyboard navigable, announce the focused node to screen readers, and include a hidden data table of all flows. Information never depends on colour alone (labels, values and tooltips carry it), and animations respect *reduce motion*.

## Known limitations

- **Diagram notes contain JSON.** In source mode you see the data block. Edit diagrams in the editor, or use **Open as Markdown** for direct edits.
- **"Open as Markdown" is remembered per tab until Obsidian restarts.** After that, the tab opens in the editor again. Turn off *Open diagrams in the Sankey editor* to always see diagram notes as Markdown.
- **Links in inline code blocks are not indexed.** Only links stored in diagram notes appear in backlinks and the graph; links written inside a `sankey-flow` code block in another note do not. `diagram:` references in code blocks are also not backlinks — use `![[Diagram]]` if you want the embed indexed.
- **Rendering is SVG.** This is fast and crisp up to several thousand flows; there is no Canvas/WebGL renderer for very large data.
- **Dataview** support is limited to `TABLE` queries and is marked experimental. It has not been tested against every Dataview version.
- **Undo history** lives in memory per editor tab and is cleared when the tab is closed or the plugin reloads.
- **Exported SVG** embeds colours and fonts as computed at export time. Fonts are not embedded, so another program may substitute similar fonts.
- **Reveal in file explorer** relies on the core File explorer plugin and is hidden when it is disabled.

## Troubleshooting

| Problem | What to do |
|---|---|
| "This diagram could not be opened" | The JSON in the note is invalid. Use **Open as Markdown**, fix the reported position, and the editor reloads automatically. The file is never overwritten while invalid. |
| "Newer diagram format" | The note was saved by a newer version of Sankey Flow. Update the plugin. |
| "Diagram not found" in a code block | The `diagram:` reference does not resolve. Check the name, or let the plugin update references on rename (setting *Update links on rename*). |
| A `sankey` code block shows as plain code or is drawn by another plugin | Another plugin already registered `sankey`. Use ```` ```sankey-flow ```` instead (with debug logging on, the console names the conflict). |
| "Autosave paused" | The file changed elsewhere while you had unsaved edits. Choose a version in the banner. |
| Nothing happens on Ctrl/Cmd+scroll in a note | Check *Zoom in embedded diagrams* in settings. |
| Something else is wrong | Turn on **Enable debug logging**, reproduce, and check the developer console (Ctrl+Shift+I / Cmd+Option+I). |

## Development

```bash
npm install
npm run dev        # rebuild on change
npm run build      # type-check and production build → main.js
npm test           # unit tests (vitest)
npm run lint       # Obsidian's official plugin rules (eslint-plugin-obsidianmd)
npm run typecheck
```

To try it in a vault, copy or symlink `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/sankey-flow/` and reload the plugin.

Project layout:

```
src/
  main.ts                    Plugin entry: registration and event wiring only
  commands.ts                Command palette commands
  constants.ts               View ids, icon
  model/                     Schema, validation & migration, operations, undo history (no Obsidian imports)
  layout/sankeyLayout.ts     Layout engine (pure): columns, relaxation, cycles, pinned nodes, link geometry
  render/                    SVG renderer, colours, formatting, render config, SVG/PNG/CSV export
  data/                      CSV, Markdown tables, column mapping, code block syntax, data sources, Dataview
  storage/                   Diagram note format (pure) and vault access (DiagramStore)
  editor/                    Editor view, controller, sidebar panels
  embed/SankeyBlock.ts       Code block processor and embed rendering
  manager/ManagerView.ts     Diagram manager
  modals/                    Prompt, confirm, pickers, import dialog
  obsidian/                  Link navigation, hover preview, link suggestions
  settings/                  Settings model and tab
  export/exporter.ts         Writes exports into the vault
tests/                       Unit tests for everything without UI
```

The model, layout, parsers and file format have no dependency on the Obsidian API and are covered by unit tests. The renderer depends only on the DOM. There are no runtime dependencies.

**Adding a data source.** Implement `SankeyDataSource` from `src/data/sources.ts` (`load()` returns a document plus validation issues, and the optional `watch()` reports changes), then create it in `SankeyBlock.setup()` for a new block option. Tabular sources can reuse `buildRows`/`documentFromRows` from `src/data/tableImport.ts` for column mapping and validation.

## License

MIT
