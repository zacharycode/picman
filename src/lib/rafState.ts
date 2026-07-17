export function createRafNumberCommitter(commit: (nextValue: number) => void, initialValue: number) {
  let pendingValue = initialValue
  let frameId = 0

  const flush = () => {
    frameId = 0
    commit(pendingValue)
  }

  return {
    update(nextValue: number) {
      pendingValue = nextValue
      if (!frameId) frameId = window.requestAnimationFrame(flush)
    },
    flush() {
      if (frameId) {
        window.cancelAnimationFrame(frameId)
        frameId = 0
      }
      commit(pendingValue)
    },
  }
}
