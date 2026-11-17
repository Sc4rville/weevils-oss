import { Component, type RefObject } from 'react'
import { isSettled } from './app-context'
import { keepInPlace } from './follow'

/** Preserve the row being read when a status change reorders this project's sessions. */
export class KeepSessionOrder extends Component<{ order: string; within: RefObject<HTMLElement | null> }> {
  pin: (() => void) | null = null
  getSnapshotBeforeUpdate(prev: { order: string }) {
    if (prev.order && prev.order !== this.props.order && isSettled() && window.scrollY > 0 && !document.documentElement.dataset.page) {
      const row = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 3)?.closest('.row')
      if (row && this.props.within.current?.contains(row)) this.pin = keepInPlace(row, 480)
    }
    return null
  }
  componentDidUpdate() {
    this.pin?.()
    this.pin = null
  }
  render() { return null }
}
