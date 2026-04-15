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

function initialsFromUser(user) {
  const text = user?.display_name || user?.email || "U";
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

export default function App() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isRegister, setIsRegister] = useState(false);

  const [updates, setUpdates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterMood, setFilterMood] = useState("all");
  const [isFilterAnimating, setIsFilterAnimating] = useState(false);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [editingId, setEditingId] = useState(null);

  const [activeUsers, setActiveUsers] = useState([]);
  const [moodTrends, setMoodTrends] = useState([]);
  const [layoutPrefs, setLayoutPrefs] = useState({
    showAnalytics: true,
    showPolls: true,
    showReactions: true,
  });
  const [favoriteMoods, setFavoriteMoods] = useState([]);

  const [toasts, setToasts] = useState([]);
  const [activeNav, setActiveNav] = useState("feed");
  const [showCompose, setShowCompose] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [lightMode, setLightMode] = useState(false);

  const socketRef = useRef(null);
  const moodChartRef = useRef(null);
  const userChartRef = useRef(null);
  const profileRef = useRef(null);
  const composeRef = useRef(null);
  const feedRef = useRef(null);
  const analyticsRef = useRef(null);
  const prefsRef = useRef(null);

  const isAdmin = useMemo(() => user && user.role === "admin", [user]);

  function notify(text, type = "info") {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, text, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }

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
      // intentionally quiet
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
      // intentionally quiet
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
      notify("New status update received.", "info");
    });
    socketRef.current.on("update:reaction", (payload) => {
      if (!payload) return;
      setUpdates((prev) => prev.map((u) => (u.id === payload.id ? payload : u)));
    });
    socketRef.current.on("poll:vote", (payload) => {
      if (!payload) return;
      setUpdates((prev) => prev.map((u) => (u.id === payload.id ? payload : u)));
    });
    socketRef.current.on("update:edit", (payload) => {
      if (!payload) return;
      setUpdates((prev) => prev.map((u) => (u.id === payload.id ? payload : u)));
      notify("Status update edited.", "info");
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

    const days = Array.from(new Set(moodTrends.map((t) => t.day)));
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
          borderColor:
            m === "positive" ? "#00ff9c" : m === "negative" ? "#ff3a6d" : "#6ab7ff",
          backgroundColor: "transparent",
          tension: 0.35,
          borderWidth: 2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { color: "#d9e4ff" } } },
        scales: {
          x: { ticks: { color: "#b6c8f9" }, grid: { color: "rgba(128, 151, 214, 0.18)" } },
          y: { ticks: { color: "#b6c8f9" }, grid: { color: "rgba(128, 151, 214, 0.18)" } },
        },
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
            backgroundColor: "rgba(67, 201, 255, 0.7)",
            borderColor: "#43c9ff",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#b6c8f9" }, grid: { color: "rgba(128, 151, 214, 0.12)" } },
          y: { ticks: { color: "#b6c8f9" }, grid: { color: "rgba(128, 151, 214, 0.12)" } },
        },
      },
    });
  }, [moodTrends, activeUsers, layoutPrefs.showAnalytics]);

  useEffect(() => {
    function onClickOutside(e) {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function handleAuth(e) {
    e.preventDefault();
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
      notify(isRegister ? "Account created." : "Signed in successfully.");
    } catch (err) {
      notify(err.message, "error");
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    setUpdates([]);
    notify("Logged out.");
  }

  async function createUpdate(e) {
    e.preventDefault();
    try {
      const payload = {
        title: title || "Status update",
        body,
      };
      if (!editingId && layoutPrefs.showPolls && pollQuestion.trim()) {
        payload.poll = {
          question: pollQuestion,
          options: pollOptions.filter((o) => o.trim().length > 0),
        };
      }
      if (editingId) {
        await api(`/api/updates/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        await api("/api/updates", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      await loadUpdates();
      await loadAnalytics();
      setTitle("");
      setBody("");
      setPollQuestion("");
      setPollOptions(["", ""]);
      setEditingId(null);
      notify("Status posted.");
    } catch (err) {
      notify(err.message, "error");
    }
  }

  function clearPostForm() {
    setTitle("");
    setBody("");
    setPollQuestion("");
    setPollOptions(["", ""]);
    setEditingId(null);
    notify("Post form cleared.");
  }

  function startEdit(update) {
    setTitle(update.title || "");
    setBody(update.body || "");
    setPollQuestion("");
    setPollOptions(["", ""]);
    setEditingId(update.id);
    setShowCompose(true);
    scrollToSection("compose");
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
      notify(err.message, "error");
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
      notify(err.message, "error");
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
      notify("Preferences saved.");
    } catch (err) {
      notify(err.message, "error");
    }
  }

  async function toggleNotifications() {
    try {
      const keyRes = await api("/api/notifications/public-key");
      if (!keyRes.publicKey) {
        notify("Push notifications are not configured on the server.", "error");
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
      notify("Notifications enabled.");
    } catch (err) {
      notify("Unable to enable notifications.", "error");
    }
  }

  async function onFilterChange(nextMood) {
    setFilterMood(nextMood);
    setIsFilterAnimating(true);
    await loadUpdates(nextMood);
    window.setTimeout(() => setIsFilterAnimating(false), 220);
  }

  function scrollToSection(section) {
    const refs = {
      compose: composeRef,
      feed: feedRef,
      analytics: analyticsRef,
      prefs: prefsRef,
    };

    if (section === "compose") {
      setShowCompose(true);
      setActiveNav(section);
      window.setTimeout(() => {
        composeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
      return;
    }

    setShowCompose(false);
    setActiveNav(section);
    const target = refs[section]?.current;
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (loading) {
    return (
      <div className="auth-page">
        <div className="gradient-bg" />
        <div className="auth-card glass-card">Loading portal...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-page">
        <div className="gradient-bg" />
        <div className="particles" aria-hidden="true">
          {Array.from({ length: 14 }).map((_, idx) => (
            <span key={idx} style={{ "--i": idx + 1 }} />
          ))}
        </div>
        <div className="auth-card glass-card slide-in-up">
          <h1>Online Status Update Portal</h1>
          <p className="muted">Next-gen status intelligence in real time.</p>
          <form onSubmit={handleAuth} className="form">
            {isRegister && (
              <>
                <label>Display name</label>
                <input
                  type="text"
                  placeholder="Nova Analyst"
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
            <button type="submit" className="neon-btn">
              {isRegister ? "Create account" : "Enter portal"}
            </button>
          </form>
          <button className="secondary" onClick={() => setIsRegister((v) => !v)}>
            {isRegister ? "Have an account? Sign in" : "New here? Create account"}
          </button>
        </div>

        <div className="toast-stack">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.type === "error" ? "toast-error" : ""}`}>
              {toast.text}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${lightMode ? "theme-light" : ""}`}>
      <div className="gradient-bg" />
      <div className="particles" aria-hidden="true">
        {Array.from({ length: 20 }).map((_, idx) => (
          <span key={idx} style={{ "--i": idx + 1 }} />
        ))}
      </div>

      <aside className="sidebar glass-card">
        <div className="brand">
          <div className="brand-dot" />
          <div>
            <h2>STATUS OS</h2>
            <p>Quantum board</p>
          </div>
        </div>

        <nav className="side-nav">
          {isAdmin && (
            <button
              type="button"
              className={activeNav === "compose" ? "active" : ""}
              onClick={() => scrollToSection("compose")}
            >
              Compose
            </button>
          )}
          <button
            type="button"
            className={activeNav === "feed" ? "active" : ""}
            onClick={() => scrollToSection("feed")}
          >
            Live Feed
          </button>
          <button
            type="button"
            className={activeNav === "analytics" ? "active" : ""}
            onClick={() => scrollToSection("analytics")}
          >
            Analytics
          </button>
          <button
            type="button"
            className={activeNav === "prefs" ? "active" : ""}
            onClick={() => scrollToSection("prefs")}
          >
            Preferences
          </button>
        </nav>
      </aside>

      <div className="main-wrap">
        <header className="topbar-glass glass-card">
          <div>
            <h1>Status Command Center</h1>
            <p className="muted">Signed in as {user.display_name || user.email}</p>
          </div>

          <div className="topbar-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => setLightMode((v) => !v)}
            >
              {lightMode ? "Dark mode" : "Light mode"}
            </button>
            <button className="secondary" type="button" onClick={toggleNotifications}>
              Notifications
            </button>

            <div className="profile" ref={profileRef}>
              <button
                type="button"
                className="avatar-btn"
                onClick={() => setProfileOpen((v) => !v)}
                aria-expanded={profileOpen}
              >
                {initialsFromUser(user)}
              </button>
              <div className={`profile-menu ${profileOpen ? "open" : ""}`}>
                <div className="profile-meta">{user.display_name || user.email}</div>
                <button type="button" onClick={logout}>
                  Logout
                </button>
              </div>
            </div>
          </div>
        </header>

        <main className="dashboard-grid">
          {isAdmin && showCompose && (
            <section ref={composeRef} className="glass-card card section-anchor fade-in">
              <h2>{editingId ? "Update status" : "Post status"}</h2>
              <form onSubmit={createUpdate} className="form">
                <label>Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Application milestone update"
                />
                <label>Status update</label>
                <textarea
                  rows="4"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Share status changes, approvals, risks, and next actions."
                  required
                />
                {layoutPrefs.showPolls && !editingId && (
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
                <div className="form-actions">
                  <button type="submit" className="neon-btn">
                    {editingId ? "Save changes" : "Publish update"}
                  </button>
                  <button type="button" className="secondary" onClick={clearPostForm}>
                    {editingId ? "Cancel edit" : "Clear form"}
                  </button>
                </div>
              </form>
            </section>
          )}

          <section ref={prefsRef} className="glass-card card section-anchor fade-in">
            <h2>Dashboard controls</h2>
            <div className="toolbar-grid">
              <div className="filter">
                <label>Mood filter</label>
                <select value={filterMood} onChange={(e) => onFilterChange(e.target.value)}>
                  <option value="all">All</option>
                  {MOODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="prefs">
                <label>Widgets</label>
                <label className="prefs-toggle">
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
                </label>
                <label className="prefs-toggle">
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
                </label>
                <label className="prefs-toggle">
                  <input
                    type="checkbox"
                    checked={layoutPrefs.showReactions}
                    onChange={(e) => {
                      const next = { ...layoutPrefs, showReactions: e.target.checked };
                      setLayoutPrefs(next);
                      savePrefs(next, favoriteMoods);
                    }}
                  />
                  <span>Reactions</span>
                </label>
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
          </section>

          {layoutPrefs.showAnalytics && (
            <section ref={analyticsRef} className="glass-card card section-anchor fade-in">
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
            </section>
          )}

          <section ref={feedRef} className="glass-card card section-anchor fade-in">
            <h2>Live status feed</h2>
            {updates.length === 0 ? (
              <div className="empty">
                <div className="empty-title">No updates yet</div>
                <div className="muted">Create the first status update to get started.</div>
              </div>
            ) : (
              <div className={`updates ${isFilterAnimating ? "is-switching" : ""}`}>
                {updates.map((u) => (
                  <div key={u.id} className={`update mood-${u.mood}`}>
                    <div className="update-head">
                      <span className={`badge badge-${u.mood}`}>{u.mood}</span>
                      <span className="muted">
                        {formatTime(u.created_at)} by {u.author_name}
                      </span>
                    </div>
                    <h3>{u.title}</h3>
                    <p>{u.body}</p>

                    {isAdmin && (
                      <div className="reactions">
                        <button
                          type="button"
                          className="reaction-btn"
                          onClick={() => startEdit(u)}
                        >
                          Edit
                        </button>
                      </div>
                    )}

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
          </section>
        </main>
      </div>

      {isAdmin && (
        <button type="button" className="fab" onClick={() => scrollToSection("compose")}>
          +
        </button>
      )}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type === "error" ? "toast-error" : ""}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}

