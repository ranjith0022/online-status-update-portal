import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import Chart from "chart.js/auto";
import { api } from "./api.js";

const MOODS = ["positive", "neutral", "negative"];
const REACTIONS = ["like", "support", "insight"];

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [updates, setUpdates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterMood, setFilterMood] = useState("all");

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);

  const [activeUsers, setActiveUsers] = useState([]);
  const [moodTrends, setMoodTrends] = useState([]);
  const [layoutPrefs, setLayoutPrefs] = useState({
    showAnalytics: true,
    showPolls: true,
    showReactions: true,
  });
  const [favoriteMoods, setFavoriteMoods] = useState([]);

  const socketRef = useRef(null);
  const moodChartRef = useRef(null);
  const userChartRef = useRef(null);

  const isAdmin = useMemo(() => user && user.role === "admin", [user]);

  async function loadUpdates(mood = filterMood) {
    try {
      const query = mood !== "all" ? `?mood=${mood}` : "";
      const list = await api(`/api/updates${query}`);
      setUpdates(list.updates || []);
      localStorage.setItem("updates_cache", JSON.stringify(list.updates || []));
    } catch (err) {
      const cached = localStorage.getItem("updates_cache");
      if (cached) setUpdates(JSON.parse(cached));
    }
  }

  async function loadAnalytics() {
    try {
      const top = await api("/api/analytics/active-users");
      const trends = await api("/api/analytics/mood-trends");
      setActiveUsers(top.topUsers || []);
      setMoodTrends(trends.trends || []);
    } catch (err) {
      // ignore analytics failures
    }
  }

  async function loadPrefs() {
    try {
      const res = await api("/api/prefs");
      if (res.prefs) {
        setLayoutPrefs(JSON.parse(res.prefs.layout_json || "{}") || {});
        setFavoriteMoods(JSON.parse(res.prefs.favorite_moods || "[]") || []);
      }
    } catch (err) {
      // ignore
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const me = await api("/api/me");
        setUser(me.user);
        await loadUpdates();
        await loadAnalytics();
        await loadPrefs();
      } catch (err) {
        // not logged in
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    socketRef.current = io(import.meta.env.VITE_API_BASE || "http://localhost:4000", {
      withCredentials: true,
    });

    socketRef.current.on("update:new", (payload) => {
      if (!payload) return;
      setUpdates((prev) => [payload, ...prev]);
    });
    socketRef.current.on("update:reaction", (payload) => {
      if (!payload) return;
      setUpdates((prev) => prev.map((u) => (u.id === payload.id ? payload : u)));
    });
    socketRef.current.on("poll:vote", (payload) => {
      if (!payload) return;
      setUpdates((prev) => prev.map((u) => (u.id === payload.id ? payload : u)));
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [user]);

  useEffect(() => {
    if (!layoutPrefs.showAnalytics) return;
    if (moodChartRef.current) moodChartRef.current.destroy();
    if (userChartRef.current) userChartRef.current.destroy();

    const moodCanvas = document.getElementById("moodChart");
    const userCanvas = document.getElementById("userChart");
    if (!moodCanvas || !userCanvas) return;

    const days = Array.from(
      new Set(moodTrends.map((t) => t.day))
    );
    const dataByMood = MOODS.map((m) =>
      days.map((d) => moodTrends.find((t) => t.day === d && t.mood === m)?.count || 0)
    );

    moodChartRef.current = new Chart(moodCanvas, {
      type: "line",
      data: {
        labels: days,
        datasets: MOODS.map((m, idx) => ({
          label: m,
          data: dataByMood[idx],
          borderColor: m === "positive" ? "#2f855a" : m === "negative" ? "#c53030" : "#1b4d89",
          backgroundColor: "transparent",
          tension: 0.3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
      },
    });

    userChartRef.current = new Chart(userCanvas, {
      type: "bar",
      data: {
        labels: activeUsers.map((u) => u.name),
        datasets: [
          {
            label: "Updates",
            data: activeUsers.map((u) => u.count),
            backgroundColor: "#1b4d89",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
      },
    });
  }, [moodTrends, activeUsers, layoutPrefs.showAnalytics]);

  async function handleAuth(e) {
    e.preventDefault();
    setMessage("");
    setMessageType("info");
    try {
      const res = await api(isRegister ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, displayName }),
      });
      setUser(res.user);
      await loadUpdates();
      await loadAnalytics();
      await loadPrefs();
      setPassword("");
    } catch (err) {
      setMessageType("error");
      setMessage(err.message);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    setUpdates([]);
  }

  async function createUpdate(e) {
    e.preventDefault();
    setMessage("");
    setMessageType("info");
    try {
      const payload = {
        title: title || "Status update",
        body,
      };
      if (layoutPrefs.showPolls && pollQuestion.trim()) {
        payload.poll = {
          question: pollQuestion,
          options: pollOptions.filter((o) => o.trim().length > 0),
        };
      }
      await api("/api/updates", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await loadUpdates();
      await loadAnalytics();
      setTitle("");
      setBody("");
      setPollQuestion("");
      setPollOptions(["", ""]);
    } catch (err) {
      setMessageType("error");
      setMessage(err.message);
    }
  }

  async function sendReaction(updateId, reaction) {
    try {
      const res = await api(`/api/updates/${updateId}/reactions`, {
        method: "POST",
        body: JSON.stringify({ reaction }),
      });
      if (res.update) {
        setUpdates((prev) => prev.map((u) => (u.id === updateId ? res.update : u)));
      }
    } catch (err) {
      setMessageType("error");
      setMessage(err.message);
    }
  }

  async function votePoll(pollId, optionId) {
    try {
      const res = await api(`/api/polls/${pollId}/vote`, {
        method: "POST",
        body: JSON.stringify({ optionId }),
      });
      if (res.update) {
        setUpdates((prev) => prev.map((u) => (u.id === res.update.id ? res.update : u)));
      }
    } catch (err) {
      setMessageType("error");
      setMessage(err.message);
    }
  }

  async function savePrefs(nextLayout, nextFavs) {
    try {
      await api("/api/prefs", {
        method: "PUT",
        body: JSON.stringify({
          layout: nextLayout,
          favoriteMoods: nextFavs,
        }),
      });
    } catch (err) {
      setMessageType("error");
      setMessage(err.message);
    }
  }

  async function toggleNotifications() {
    try {
      const keyRes = await api("/api/notifications/public-key");
      if (!keyRes.publicKey) {
        setMessageType("error");
        setMessage("Push notifications not configured on server.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey),
      });
      await api("/api/notifications/subscribe", {
        method: "POST",
        body: JSON.stringify(subscription),
      });
      setMessageType("info");
      setMessage("Notifications enabled.");
    } catch (err) {
      setMessageType("error");
      setMessage("Unable to enable notifications.");
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div className="card">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="page">
        <div className="card">
          <h1>Online Status Update Portal</h1>
          <p className="muted">Secure sign-in for your team.</p>
          <form onSubmit={handleAuth} className="form">
            {isRegister && (
              <>
                <label>Display name</label>
                <input
                  type="text"
                  placeholder="Jane Doe"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </>
            )}
            <label>Email</label>
            <input
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label>Password</label>
            <input
              type="password"
              placeholder="Minimum 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button type="submit">{isRegister ? "Create account" : "Sign in"}</button>
          </form>
          <button className="secondary" onClick={() => setIsRegister((v) => !v)}>
            {isRegister ? "Have an account? Sign in" : "New here? Create account"}
          </button>
          {message && (
            <div className={`message ${messageType === "error" ? "message-error" : ""}`}>
              {message}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Online Status Update Portal</h1>
          <p className="muted">Signed in as {user.display_name || user.email}</p>
        </div>
        <div className="topbar-actions">
          <button className="secondary" onClick={toggleNotifications}>
            Enable notifications
          </button>
          <button onClick={logout}>Logout</button>
        </div>
      </header>

      {message && (
        <div className={`message ${messageType === "error" ? "message-error" : ""}`}>
          {message}
        </div>
      )}

      <div className="toolbar">
        <div className="filter">
          <label>Mood filter</label>
          <select
            value={filterMood}
            onChange={(e) => {
              const val = e.target.value;
              setFilterMood(val);
              loadUpdates(val);
            }}
          >
            <option value="all">All</option>
            {MOODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="prefs">
          <label>Dashboard</label>
          <div className="prefs-toggle">
            <input
              type="checkbox"
              checked={layoutPrefs.showAnalytics}
              onChange={(e) => {
                const next = { ...layoutPrefs, showAnalytics: e.target.checked };
                setLayoutPrefs(next);
                savePrefs(next, favoriteMoods);
              }}
            />
            <span>Analytics</span>
          </div>
          <div className="prefs-toggle">
            <input
              type="checkbox"
              checked={layoutPrefs.showPolls}
              onChange={(e) => {
                const next = { ...layoutPrefs, showPolls: e.target.checked };
                setLayoutPrefs(next);
                savePrefs(next, favoriteMoods);
              }}
            />
            <span>Polls</span>
          </div>
        </div>
        <div className="prefs">
          <label>Favorite moods</label>
          <div className="prefs-row">
            {MOODS.map((m) => (
              <label key={m} className="pill">
                <input
                  type="checkbox"
                  checked={favoriteMoods.includes(m)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...favoriteMoods, m]
                      : favoriteMoods.filter((x) => x !== m);
                    setFavoriteMoods(next);
                    savePrefs(layoutPrefs, next);
                  }}
                />
                <span>{m}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {isAdmin && (
        <div className="card">
          <h2>Post a status</h2>
          <form onSubmit={createUpdate} className="form">
            <label>Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Weekly progress"
            />
            <label>Status update</label>
            <textarea
              rows="4"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Share what changed, blockers, and next steps."
              required
            />
            {layoutPrefs.showPolls && (
              <div className="poll-builder">
                <label>Poll question (optional)</label>
                <input
                  value={pollQuestion}
                  onChange={(e) => setPollQuestion(e.target.value)}
                  placeholder="Which initiative should be prioritized?"
                />
                <label>Poll options</label>
                {pollOptions.map((opt, idx) => (
                  <input
                    key={idx}
                    value={opt}
                    onChange={(e) => {
                      const next = [...pollOptions];
                      next[idx] = e.target.value;
                      setPollOptions(next);
                    }}
                    placeholder={`Option ${idx + 1}`}
                  />
                ))}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setPollOptions((prev) => [...prev, ""])}
                >
                  Add option
                </button>
              </div>
            )}
            <button type="submit">Publish</button>
          </form>
        </div>
      )}

      {layoutPrefs.showAnalytics && (
        <div className="card">
          <h2>Analytics</h2>
          <div className="analytics-grid">
            <div className="chart-card">
              <h3>Mood trend</h3>
              <div className="chart-wrap">
                <canvas id="moodChart" height="220" />
              </div>
            </div>
            <div className="chart-card">
              <h3>Most active users</h3>
              <div className="chart-wrap">
                <canvas id="userChart" height="220" />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Latest updates</h2>
        {updates.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No updates yet</div>
            <div className="muted">Create the first status update to get started.</div>
          </div>
        ) : (
          <div className="updates">
            {updates.map((u) => (
              <div key={u.id} className="update">
                <div className="update-head">
                  <span className={`badge badge-${u.mood}`}>{u.mood}</span>
                  <span className="muted">
                    {formatTime(u.created_at)} by {u.author_name}
                  </span>
                </div>
                <h3>{u.title}</h3>
                <p>{u.body}</p>

                {layoutPrefs.showReactions && (
                  <div className="reactions">
                    {REACTIONS.map((r) => {
                      const count = u.reactions?.find((x) => x.reaction === r)?.count || 0;
                      return (
                        <button
                          key={r}
                          type="button"
                          className="reaction-btn"
                          onClick={() => sendReaction(u.id, r)}
                        >
                          {r} · {count}
                        </button>
                      );
                    })}
                  </div>
                )}

                {u.poll && (
                  <div className="poll">
                    <div className="poll-question">{u.poll.question}</div>
                    <div className="poll-options">
                      {u.poll.options.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`poll-option ${u.poll.myVote === opt.id ? "selected" : ""}`}
                          onClick={() => votePoll(u.poll.id, opt.id)}
                        >
                          <span>{opt.text}</span>
                          <span className="muted">{opt.votes} votes</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
