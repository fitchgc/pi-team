import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type Mode = ExtensionCommandContext["mode"];
type UI = Pick<ExtensionCommandContext["ui"], "notify">;
type Writer = { write(text: string): void };
type Output = { stdout: Writer; stderr: Writer };

export function deliverReport(
  mode: Mode,
  text: string,
  send: (text: string) => void,
  output: Output = process,
): void {
  if (mode === "print") output.stdout.write(text + "\n");
  else send(text);
}

export function notify(
  mode: Mode,
  ui: UI,
  message: string,
  type: "info" | "warning" | "error",
  output: Output = process,
): void {
  if (mode === "print") {
    const stream = type === "error" ? output.stderr : output.stdout;
    stream.write(message + "\n");
  } else {
    ui.notify(message, type);
  }
}
