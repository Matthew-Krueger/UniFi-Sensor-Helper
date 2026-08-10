import { describe, expect, test } from "bun:test";
import { canAssignRole } from "@unifi-sensor-latch/shared";
import { AuthStore, RoleError } from "../src/auth";
import { createTestDb } from "../src/db";

// SPEC.md section 3a — the role model this project explicitly reversed a
// prior "no roles" decision for. Covers: the first account is always
// superadmin regardless of requested role (the "explicit, unconditional
// check" requirement from CLAUDE.md), an admin can never grant superadmin,
// and role changes are gated to superadmin only.

describe("canAssignRole", () => {
  test("superadmin can grant any role", () => {
    expect(canAssignRole("superadmin", "user")).toBe(true);
    expect(canAssignRole("superadmin", "admin")).toBe(true);
    expect(canAssignRole("superadmin", "superadmin")).toBe(true);
  });

  test("admin can grant user/admin but never superadmin", () => {
    expect(canAssignRole("admin", "user")).toBe(true);
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canAssignRole("admin", "superadmin")).toBe(false);
  });

  test("user can grant nothing", () => {
    expect(canAssignRole("user", "user")).toBe(false);
    expect(canAssignRole("user", "admin")).toBe(false);
    expect(canAssignRole("user", "superadmin")).toBe(false);
  });
});

describe("AuthStore bootstrap and roles", () => {
  test("the first account is always superadmin, even if a different role is requested", async () => {
    const store = new AuthStore(createTestDb());
    const first = await store.addUser("alice", "hunter2hunter2", "user");
    expect(first.role).toBe("superadmin");
  });

  test("subsequent accounts get the requested role, not superadmin", async () => {
    const store = new AuthStore(createTestDb());
    await store.addUser("alice", "hunter2hunter2");
    const second = await store.addUser("bob", "hunter2hunter2", "admin");
    expect(second.role).toBe("admin");
  });

  test("setRole rejects a non-superadmin actor", async () => {
    const store = new AuthStore(createTestDb());
    const alice = await store.addUser("alice", "hunter2hunter2"); // superadmin (first account)
    const bob = await store.addUser("bob", "hunter2hunter2", "admin");

    await expect(store.setRole("admin", alice.id, "user")).rejects.toBeInstanceOf(RoleError);
    const promoted = await store.setRole("superadmin", bob.id, "superadmin");
    expect(promoted.role).toBe("superadmin");
  });

  test("changePassword requires the current password", async () => {
    const store = new AuthStore(createTestDb());
    const user = await store.addUser("alice", "old-password-123");

    expect(await store.changePassword(user.id, "wrong-password", "new-password-123")).toBe(false);
    expect(await store.changePassword(user.id, "old-password-123", "new-password-123")).toBe(true);

    expect(await store.verify("alice", "old-password-123")).toBeNull();
    expect(await store.verify("alice", "new-password-123")).not.toBeNull();
  });
});
