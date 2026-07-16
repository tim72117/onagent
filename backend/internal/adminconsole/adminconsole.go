// Package adminconsole serves the admin back-office API under /admin/api/*.
// It is intentionally a separate handler from internal/console (the
// developer-facing API): a separate identity system (internal/adminauth),
// a separate cookie, and its own withAdmin gate that fail-closed-rejects
// anyone who is not a verified admin. The only capabilities exposed today
// are viewing accounts and changing a user's plan (tier); see the design
// discussion for why the whole thing is a distinct system rather than a
// role flag on the developer accounts.
package adminconsole

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	"github.com/tim72117/onagent/internal/adminauth"
	"github.com/tim72117/onagent/internal/quota"
)

// Handler serves /admin/api/*. Auth is the admin identity/session store;
// Quota provides the account listing and plan changes.
type Handler struct {
	Auth  *adminauth.Store
	Quota *quota.Service
}

func NewHandler(auth *adminauth.Store, quotaSvc *quota.Service) *Handler {
	return &Handler{Auth: auth, Quota: quotaSvc}
}

// Register mounts the admin API routes on mux. Login is unauthenticated (it
// is how you become authenticated); everything else is behind withAdmin.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /admin/api/login", h.login)
	mux.HandleFunc("POST /admin/api/logout", h.logout)
	mux.HandleFunc("GET /admin/api/me", h.withAdmin(h.me))

	mux.HandleFunc("GET /admin/api/plans", h.withAdmin(h.listPlans))
	mux.HandleFunc("GET /admin/api/users", h.withAdmin(h.listUsers))
	mux.HandleFunc("PUT /admin/api/users/{userId}/plan", h.withAdmin(h.setUserPlan))
}

// withAdmin is the single gate for every privileged admin route: it
// resolves the admin session cookie and rejects the request with 401 if it
// doesn't resolve to a valid admin. Fail-closed by construction — a handler
// wrapped in withAdmin cannot run for a non-admin.
func (h *Handler) withAdmin(next func(http.ResponseWriter, *http.Request, *adminauth.Admin)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		admin, ok := h.Auth.Verify(r)
		if !ok {
			http.Error(w, "not authenticated", http.StatusUnauthorized)
			return
		}
		next(w, r, admin)
	}
}

// --- auth ----------------------------------------------------------------

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type adminResponse struct {
	Email string `json:"email"`
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	admin, err := h.Auth.Login(req.Email, req.Password)
	if err != nil {
		// Same opaque message for unknown-email and wrong-password (see
		// adminauth.ErrInvalidCredentials).
		http.Error(w, "invalid admin credentials", http.StatusUnauthorized)
		return
	}
	if _, err := h.Auth.CreateSession(w, admin.ID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, adminResponse{Email: admin.Email})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	h.Auth.Logout(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request, admin *adminauth.Admin) {
	writeJSON(w, http.StatusOK, adminResponse{Email: admin.Email})
}

// --- plans & users -------------------------------------------------------

type planInfo struct {
	Tier           string `json:"tier"`
	Name           string `json:"name"`
	MonthlyPrompts int    `json:"monthlyPrompts"`
}

// listPlans returns the plan catalog so the SPA can render a plan selector
// with real names/limits instead of hard-coding tiers client-side.
func (h *Handler) listPlans(w http.ResponseWriter, r *http.Request, _ *adminauth.Admin) {
	plans := quota.AllPlans()
	out := make([]planInfo, 0, len(plans))
	for _, p := range plans {
		out = append(out, planInfo{Tier: string(p.Tier), Name: p.Name, MonthlyPrompts: p.MonthlyPrompts})
	}
	// Stable order by allowance so the list is deterministic (AllPlans is
	// map iteration).
	sort.Slice(out, func(i, j int) bool { return out[i].MonthlyPrompts < out[j].MonthlyPrompts })
	writeJSON(w, http.StatusOK, out)
}

type usersResponse struct {
	Total int                 `json:"total"`
	Users []quota.UserSummary `json:"users"`
}

// listUsers is the dashboard's main call: the headline account count plus
// the per-user table (email, plan, usage this period).
func (h *Handler) listUsers(w http.ResponseWriter, r *http.Request, _ *adminauth.Admin) {
	ctx := r.Context()
	total, err := h.Quota.CountUsers(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	users, err := h.Quota.ListUsers(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, usersResponse{Total: total, Users: users})
}

type setPlanRequest struct {
	Tier string `json:"tier"`
}

// setUserPlan changes one user's subscription tier. The tier is validated
// against the plan catalog inside quota.SetTier (unknown tier → 400 here).
func (h *Handler) setUserPlan(w http.ResponseWriter, r *http.Request, _ *adminauth.Admin) {
	userID, err := strconv.ParseInt(r.PathValue("userId"), 10, 64)
	if err != nil {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}
	var req setPlanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if err := h.Quota.SetTier(r.Context(), userID, quota.Tier(req.Tier)); err != nil {
		// Unknown tier is a client error; anything else is a server error.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
