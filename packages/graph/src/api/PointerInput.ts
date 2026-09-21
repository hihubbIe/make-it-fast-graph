/**
 * Main-thread pointer/wheel capture. Converts DOM events to device-px records
 * and hands them to a sink (InputRing or postMessage fallback). Handlers do
 * no layout reads on the hot path: the canvas rect is cached and refreshed
 * only on enter/down/resize/scroll.
 */
import { INPUT, MOD } from "../bridge/InputRing";

export type InputSink = (type: number, t: number, x: number, y: number, dx: number, dy: number, buttons: number, mods: number) => void;

const LINE_PX = 16;

function mods(e: MouseEvent): number {
  return (e.shiftKey ? MOD.SHIFT : 0) | (e.ctrlKey ? MOD.CTRL : 0) | (e.altKey ? MOD.ALT : 0) | (e.metaKey ? MOD.META : 0);
}

export class PointerInput {
  private left = 0;
  private top = 0;
  private readonly controller = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sink: InputSink,
    private readonly pixelRatio: () => number,
  ) {
    const opts = { signal: this.controller.signal };
    const passive = { signal: this.controller.signal, passive: true };
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerenter", this.refreshRect, passive);
    canvas.addEventListener("pointerdown", this.onDown, opts);
    canvas.addEventListener("pointermove", this.onMove, passive);
    canvas.addEventListener("pointerup", this.onUp, passive);
    canvas.addEventListener("pointercancel", this.onUp, passive);
    canvas.addEventListener("pointerleave", this.onLeave, passive);
    canvas.addEventListener("wheel", this.onWheel, { signal: this.controller.signal, passive: false });
    window.addEventListener("scroll", this.refreshRect, { signal: this.controller.signal, passive: true, capture: true });
    this.refreshRect();
  }

  readonly refreshRect = (): void => {
    const r = this.canvas.getBoundingClientRect();
    this.left = r.left;
    this.top = r.top;
  };

  dispose(): void {
    this.controller.abort();
  }

  private push(type: number, e: MouseEvent, dx = 0, dy = 0): void {
    const k = this.pixelRatio();
    this.sink(type, e.timeStamp, (e.clientX - this.left) * k, (e.clientY - this.top) * k, dx, dy, e.buttons, mods(e));
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.refreshRect();
    this.canvas.setPointerCapture(e.pointerId);
    this.push(INPUT.POINTER_DOWN, e);
  };

  private readonly onMove = (e: PointerEvent): void => {
    this.push(INPUT.POINTER_MOVE, e);
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.push(INPUT.POINTER_UP, e);
  };

  private readonly onLeave = (e: PointerEvent): void => {
    this.push(INPUT.POINTER_LEAVE, e);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    this.push(INPUT.WHEEL, e, e.deltaX * scale, e.deltaY * scale);
  };
}
