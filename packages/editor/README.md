# @glyphdown/editor

CodeMirror 6 extensions for the Glyphdown editor: Obsidian-style live preview
over GFM markdown, the Yjs collab binding, comment/suggestion range rendering,
and suggest mode (edits routed through `@glyphdown/core`'s `SuggestSession`).

## Exports

| Export | What it is |
|---|---|
| `glyphdownMarkdown()` | Language: GFM `markdownLanguage` + `codeLanguages` from language-data + YAML frontmatter |
| `livePreview()`, `livePreviewField` | Live-preview decorations (hide syntax away from the selection, checkboxes, link chips, image placeholders, styled blocks) |
| `toggleCheckboxChange(doc, pos)` | Pure change computation for flipping a `[ ]`/`[x]` task marker |
| `glyphdownCollab(ytext, awareness, undoManager)` | `yCollab` + `yUndoManagerKeymap`. **Never add CM `history()` next to this** |
| `docAnnotations()`, `docAnnotationsField`, `setDocAnnotationsEffect`, `dispatchDocAnnotations` | Comment + suggestion range rendering |
| `createSuggestMode(config)`, `suggestModeOrigin` | Suggest mode (put `.extension` in a `Compartment`) |
| `markdownAutoClose()`, `markdownFormat(state, open, close?)` | Markdown pair insertion, word wrapping, Backspace pair deletion, and Mod-B/I/U formatting shortcuts |
| `glyphdownTheme`, `glyphdownHighlighting()`, `glyphdownHighlightStyle` | Minimal document-like default theme (all classes overridable) |

## Integration

Provider wiring is the app's job — use y-partyserver's `YProvider` (party
`doc-do`, room = docId); it is the only stock client that keeps the DocDO
hibernating.

```ts
import * as Y from 'yjs'
import YProvider from 'y-partyserver/provider'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap } from '@codemirror/commands'
import {
  glyphdownMarkdown, livePreview, glyphdownCollab, docAnnotations,
  dispatchDocAnnotations, createSuggestMode, glyphdownTheme, glyphdownHighlighting,
} from '@glyphdown/editor'
import { resolveAnchor } from '@glyphdown/core'

const ydoc = new Y.Doc()
const provider = new YProvider(location.origin, docId, ydoc, { party: 'doc-do' })
const ytext = ydoc.getText('content')
const undoManager = new Y.UndoManager(ytext) // yCollab adds its sync origin

const suggestCompartment = new Compartment()
const suggestMode = createSuggestMode({
  ytext,
  authorId: me.id,
  newId: () => crypto.randomUUID(),
  onSuggestion: (records) => socket.sendSuggestionUpserts(records), // persist by id
})

const view = new EditorView({
  state: EditorState.create({
    doc: ytext.toString(),
    extensions: [
      keymap.of(defaultKeymap), // no history()/historyKeymap — Yjs owns undo
      glyphdownMarkdown(),
      glyphdownHighlighting(),
      livePreview(),
      glyphdownTheme,
      glyphdownCollab(ytext, provider.awareness, undoManager),
      docAnnotations(),
      suggestCompartment.of([]), // empty = edit mode
    ],
  }),
  parent: element,
})

// Toggle suggest mode (suggester-role users stay locked on):
view.dispatch({ effects: suggestCompartment.reconfigure(suggestMode.extension) })
// ...and back to edit mode:
view.dispatch({ effects: suggestCompartment.reconfigure([]) })

// Whenever sidecar state changes (WS DocEvent) or the doc is rewritten
// out-of-band, resolve anchors against the Y.Doc and push the result in:
function refreshAnnotations(comments, suggestions) {
  dispatchDocAnnotations(view, {
    comments: comments.flatMap((comment) => {
      const range = comment.anchor && resolveAnchor(ytext, comment.anchor)
      return range ? [{ comment, range }] : []
    }),
    suggestions: suggestions.map((suggestion) => ({
      suggestion,
      parts: suggestion.parts.flatMap((part) => {
        const range = resolveAnchor(ytext, part.anchor)
        return range ? [{ kind: part.kind, range }] : []
      }),
    })),
  })
}
```

### How suggest mode works

A `transactionFilter` cancels every doc-changing transaction whose start doc
still matches the Y.Text (a genuine local edit — sync echoes and remote edits
start from a doc that no longer matches and pass through). The captured
changes are replayed through `SuggestSession` on the next microtask:
insertions land in the Y.Text (tracked as suggested-insert parts), deletions
of original text are only marked, deletions of the author's own pending
insertions apply for real. The yCollab binding then echoes the effective
change back into the view, and the cursor is placed explicitly (marked
deletions keep their text, so the caret must hop over it).

`onSuggestion` fires with `session.touched()` after every routed edit —
upsert those records (by id) into persistence and broadcast them.

Notes:

- Suggest-mode mutations use the `suggestModeOrigin` transaction origin. They
  are **not** undoable by default; add the origin to the `Y.UndoManager`'s
  tracked origins if you want local undo of suggested text.
- Click handling for comment/suggestion ranges: listen for clicks on
  `[data-comment-id]` / `[data-suggestion-id]` via `EditorView.domEventHandlers`.
- All decoration classes are `cm-ink-*` and overridable; `glyphdownTheme` is
  optional.
