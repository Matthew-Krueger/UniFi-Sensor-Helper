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

  // Two concurrent bootstrap signups both see an empty table and race to
  // become "first" — exactly the scenario the project owner flagged as
  // "not atomic." tryCreateFirstUser must let exactly one through as
  // superadmin and reject the other, never create two superadmins from a
  // single empty table.
  test("concurrent bootstrap signups: exactly one becomes the first account", async () => {
    const store = new AuthStore(createTestDb());

    const [a, b] = await Promise.all([
      store.tryCreateFirstUser("alice", "hunter2hunter2"),
      store.tryCreateFirstUser("bob", "hunter2hunter2"),
    ]);

    const winners = [a, b].filter((u) => u !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.role).toBe("superadmin");
    expect(store.count()).toBe(1);
  });

  test("tryCreateFirstUser returns null once an account already exists", async () => {
    const store = new AuthStore(createTestDb());
    await store.addUser("alice", "hunter2hunter2");

    const result = await store.tryCreateFirstUser("bob", "hunter2hunter2");
    expect(result).toBeNull();
    expect(store.count()).toBe(1);
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

  test("bootstrap/self-chosen accounts never require a reset", async () => {
    const store = new AuthStore(createTestDb());
    const user = await store.addUser("alice", "hunter2hunter2");
    expect(user.mustResetPassword).toBe(false);
  });
});

describe("generated passwords and forced reset", () => {
  test("createUserWithGeneratedPassword forces a reset and returns a usable 16-char password", async () => {
    const store = new AuthStore(createTestDb());
    await store.addUser("root", "hunter2hunter2"); // first account, so bob below isn't forced to superadmin

    const { user, password } = await store.createUserWithGeneratedPassword("bob", "admin");
    expect(user.mustResetPassword).toBe(true);
    expect(user.role).toBe("admin");
    expect(password).toHaveLength(16);
    expect(password).toMatch(/^[A-Za-z0-9]{16}$/);

    // the generated password actually authenticates
    const verified = await store.verify("bob", password);
    expect(verified?.mustResetPassword).toBe(true);
  });

  test("changePassword clears mustResetPassword", async () => {
    const store = new AuthStore(createTestDb());
    await store.addUser("root", "hunter2hunter2");
    const { user, password } = await store.createUserWithGeneratedPassword("bob", "user");

    const ok = await store.changePassword(user.id, password, "a-new-chosen-password");
    expect(ok).toBe(true);
    const reloaded = await store.verify("bob", "a-new-chosen-password");
    expect(reloaded?.mustResetPassword).toBe(false);
  });

  test("invalidatePassword forces a reset without changing the hash", async () => {
    const store = new AuthStore(createTestDb());
    const alice = await store.addUser("alice", "still-works-123");

    const updated = store.invalidatePassword(alice.id);
    expect(updated?.mustResetPassword).toBe(true);

    // old password still authenticates — it's marked invalid, not rotated
    const verified = await store.verify("alice", "still-works-123");
    expect(verified).not.toBeNull();
    expect(verified?.mustResetPassword).toBe(true);
  });

  test("resetPasswordToRandom rotates the hash and forces a reset", async () => {
    const store = new AuthStore(createTestDb());
    const alice = await store.addUser("alice", "old-password-123");

    const result = await store.resetPasswordToRandom(alice.id);
    expect(result?.user.mustResetPassword).toBe(true);
    expect(result?.password).toHaveLength(16);

    expect(await store.verify("alice", "old-password-123")).toBeNull();
    const reVerified = await store.verify("alice", result!.password);
    expect(reVerified).not.toBeNull();
  });
});
