"use client";

import { useEffect, useState } from "react";
import { opaqueId } from "@matchday/ui";
import {
  acceptFriendRequest,
  getFriendRequests,
  getFriends,
  sendFriendRequest,
  type CasualFriend,
  type CasualFriendRequest,
} from "@/lib/casual-account";
import { casualCopy as c } from "@/lib/casual-copy";
import styles from "./Casual.module.css";

export function CasualFriends() {
  const [email, setEmail] = useState("");
  const [friends, setFriends] = useState<CasualFriend[]>([]);
  const [requests, setRequests] = useState<CasualFriendRequest[]>([]);
  const [accountId, setAccountId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [nextFriends, nextRequests] = await Promise.all([getFriends(), getFriendRequests()]);
    setFriends(nextFriends);
    setRequests(nextRequests);
  }

  useEffect(() => {
    void fetch("/api/v1/identity/me", { cache: opaqueId("no-store") })
      .then((response) => response.json())
      .then((value: { account?: { id?: string } }) => setAccountId(value.account?.id ?? ""))
      .catch(() => undefined);
    void Promise.all([getFriends(), getFriendRequests()])
      .then(([nextFriends, nextRequests]) => {
        setFriends(nextFriends);
        setRequests(nextRequests);
      })
      .catch(() => undefined);
  }, []);

  async function send() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await sendFriendRequest(email.trim());
      setEmail("");
      setMessage(c.friendSent);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : c.friendSendFailed);
    } finally {
      setBusy(false);
    }
  }

  async function accept(id: string) {
    setBusy(true);
    try {
      await acceptFriendRequest(id);
      setMessage(c.friendAccepted);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : c.friendAcceptFailed);
    } finally {
      setBusy(false);
    }
  }

  const incoming = requests.filter((request) => request.status === "pending" && request.recipient_id === accountId);
  return (
    <section className={styles.friendsCard} aria-labelledby="casual-friends-title">
      <div>
        <span className={styles.eyebrow}>{c.connect}</span>
        <h2 id="casual-friends-title">{c.friends}</h2>
        <p>{c.friendHint}</p>
      </div>
      <div className={styles.friendControls}>
        <label className={styles.field}>
          {c.friendEmail}
          <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button className={styles.primaryButton} type="button" onClick={() => void send()} disabled={busy}>
          {c.sendRequest}
        </button>
        {message ? (
          <p className={styles.notice} role="status">
            {message}
          </p>
        ) : null}
        {incoming.length ? (
          <div>
            <h3>{c.pending}</h3>
            {incoming.map((request) => (
              <div className={styles.friendRow} key={request.id}>
                <span>{request.sender_name}</span>
                <button type="button" disabled={busy} onClick={() => void accept(request.id)}>
                  {c.accept}
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {friends.length ? (
          <div className={styles.friendTags}>
            {friends.map((friend) => (
              <span key={friend.id}>{friend.display_name}</span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
