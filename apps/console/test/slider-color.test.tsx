import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ColorPicker, hexToHsl, hslToHex } from "../src/ui/ColorPicker.tsx";
import { Slider } from "../src/ui/Slider.tsx";

afterEach(cleanup);

describe("Slider", () => {
  it("labels the range, shows and announces the formatted value, and reports changes", () => {
    const onChange = vi.fn();
    render(<Slider label="Glass blur" min={0} max={40} step={2} value={22} onChange={onChange} format={(v) => `${v}px`} />);
    const input = screen.getByLabelText("Glass blur") as HTMLInputElement;
    expect(screen.getByText("22px")).toBeTruthy();
    expect(input.getAttribute("aria-valuetext")).toBe("22px");
    fireEvent.change(input, { target: { value: "30" } });
    expect(onChange).toHaveBeenCalledWith(30);
  });
});

describe("ColorPicker", () => {
  it("converts between hex and hsl without drifting", () => {
    for (const hex of ["#e8b25c", "#7aa2ff", "#4cc38a", "#808080", "#000000", "#ffffff"]) {
      const back = hexToHsl(hslToHex(hexToHsl(hex)));
      expect(hslToHex(back)).toBe(hslToHex(hexToHsl(hex)));
    }
  });

  it("opens our popover, accepts a typed hex, closes on Escape", () => {
    function Host() {
      const [v, setV] = useState("#e8b25c");
      return <><ColorPicker label="Custom accent" value={v} onChange={setV} /><output data-testid="v">{v}</output></>;
    }
    render(<Host />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Custom accent/ }));
    expect(screen.getByRole("dialog", { name: "Custom accent" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Custom accent (hex)"), { target: { value: "#112233" } });
    expect(screen.getByTestId("v").textContent).toBe("#112233");
    fireEvent.change(screen.getByLabelText("Lightness"), { target: { value: "80" } });
    expect(screen.getByTestId("v").textContent).not.toBe("#112233");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
