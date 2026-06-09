import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The jsdom widget tests (tables, images, hanging indents) render through
    // CodeMirror's measure cycle; under parallel workers a starved worker can
    // query the DOM before the widget paints, flaking nondeterministically.
    // Serial execution is deterministic and costs only a few seconds.
    fileParallelism: false,
  },
})
