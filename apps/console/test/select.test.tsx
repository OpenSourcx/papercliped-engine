import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Select } from "../src/ui/Select.tsx";

function Demo({ onPick }: { onPick: (v: string) => void }) {
  const [v, setV] = useState("a");
  return (
    <>
      <label htmlFor="s">Mode</label>
      <Select id="s" value={v} onChange={(e) => { setV(e.target.value); onPick(e.target.value); }}>
        <optgroup label="Fast"><option value="a">Alpha</option><option value="b">Beta</option></optgroup>
        <option value="c" disabled>Gamma</option>
        <option value="d">Delta</option>
      </Select>
    </>
  );
}

afterEach(cleanup);

describe("the dropdown", () => {
  it("is still a labelled select that forms and tests can drive", () => {
    const picks: string[] = [];
    render(<Demo onPick={(v) => picks.push(v)} />);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "b" } });
    expect(picks).toEqual(["b"]);
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("b");
  });

  it("opens our list, not the browser's, and choosing sets the value", () => {
    const picks: string[] = [];
    render(<Demo onPick={(v) => picks.push(v)} />);
    const sel = screen.getByLabelText("Mode");
    fireEvent.mouseDown(sel);
    const list = screen.getByRole("listbox");
    expect(list.textContent).toContain("Fast");
    expect(Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    fireEvent.click(screen.getByText("Delta", { selector: '[role="option"] span' }));
    expect(picks).toEqual(["d"]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("works from the keyboard and skips disabled options", () => {
    const picks: string[] = [];
    render(<Demo onPick={(v) => picks.push(v)} />);
    const sel = screen.getByLabelText("Mode");
    fireEvent.keyDown(sel, { key: "Enter" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(sel, { key: "ArrowDown" });
    fireEvent.keyDown(sel, { key: "ArrowDown" });
    fireEvent.keyDown(sel, { key: "Enter" });
    expect(picks).toEqual(["d"]);
    fireEvent.keyDown(sel, { key: " " });
    fireEvent.keyDown(sel, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
