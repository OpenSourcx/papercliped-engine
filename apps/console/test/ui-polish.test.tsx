// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({ setup: { deviceName: "pve" }, data: { guests: [{ vmid: 101, name: "ct-web" }] } }),
}));

import { Button, RowCards, SectionTitle } from "../src/ui/primitives.tsx";
import { BackupTable } from "../src/pages/backups/Backups.tsx";

afterEach(cleanup);

describe("Button disabled reasons", () => {
  it("stays focusable, explains itself, and never fires while disabled", () => {
    const click = vi.fn();
    render(<Button variant="primary" disabled disabledReason="Add a name first" onClick={click}>Next</Button>);
    const b = screen.getByRole("button", { name: "Next" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect((b as HTMLButtonElement).disabled).toBe(false);
    expect(b.title).toBe("Add a name first");
    fireEvent.click(b);
    expect(click).not.toHaveBeenCalled();
  });
  it("a disabled primary is dashed and flat, so it cannot be mistaken for the enabled one", () => {
    render(<><Button variant="primary" disabled>Off</Button><Button variant="primary">On</Button></>);
    expect(screen.getByText("Off").className).toContain("disabled:border-dashed");
    expect(screen.getByText("On").className).toContain("bg-primary");
  });
  it("without a reason it is an ordinary disabled button", () => {
    render(<Button disabled>Go</Button>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
  it("loading is busy and disabled even with a reason", () => {
    render(<Button loading disabled disabledReason="x">Save</Button>);
    const b = screen.getByRole("button") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
  });
});

describe("phone layouts", () => {
  it("RowCards shows each row's title, fields and actions, and is phone-only", () => {
    const open = vi.fn();
    render(<RowCards label="Things" rows={[{ key: "a", title: "alpha", fields: [["Size", "1 GiB"], ["State", "Up"]], actions: <button type="button">Edit</button>, onOpen: open }]} />);
    const list = screen.getByRole("list", { name: "Things" });
    expect(list.className).toContain("md:hidden");
    expect(within(list).getByText("1 GiB")).toBeTruthy();
    fireEvent.click(within(list).getByText("Edit"));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(list).getByText("alpha"));
    expect(open).toHaveBeenCalledOnce();
  });

  it("the backup table has a card list for phones and keeps its table for md and up", () => {
    const files = [{ volid: "local:backup/vzdump-lxc-101.tar.zst", vmid: 101, storage: "local", at: 1_700_000_000, size: 2 ** 30, notes: "nightly" }];
    const { container } = render(<MemoryRouter><BackupTable files={files as never} /></MemoryRouter>);
    const list = screen.getByRole("list", { name: "Backups" });
    expect(list.className).toContain("md:hidden");
    expect(within(list).getByText("ct-web")).toBeTruthy();
    expect(within(list).getByRole("button", { name: /Restore/ })).toBeTruthy();
    expect(container.querySelector("table")?.className).toContain("hidden md:table");
  });

  it("section actions get the touch-size wrapper", () => {
    render(<SectionTitle action={<a href="/x">View all</a>}>Things</SectionTitle>);
    expect(screen.getByText("View all").parentElement?.className).toBe("section-action");
  });
});
