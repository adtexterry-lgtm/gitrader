// SPDX-License-Identifier: Apache-2.0
// GEP reference engine (protocol example, Go standard library only).
//
// This is a teaching implementation of the engine side of GEP over stdio NDJSON:
// framing, handshake, the error model (Problem objects), secret-field rejection
// and graceful shutdown. It has no trading logic at all and places no orders.
//
// Wire format: one UTF-8 JSON value per line, no BOM. A line is either one
// JSON-RPC message or an array (batch) of messages; a batch is answered with an
// array whose ids correspond one to one.
//
// Behaviour is ported case by case from the Python reference engine next door
// (../python-engine/engine.py); the wire contract is packages/protocol/src/gep/.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// tokenEnv names the environment variable the host puts the session token in.
	tokenEnv = "GITRADER_GEP_TOKEN"
	// engineID is the id reported by engine.describe.
	engineID = "go-reference"
	// engineName is the display name reported by engine.describe.
	engineName      = "Go reference engine (protocol example)"
	engineVersion   = "0.1.0"
	supportedV010   = "0.1"
	maxLineBytes    = 1024 * 1024
	hostCallTimeout = 5 * time.Second
	// exitGrace caps how long engine.shutdown's graceMs may delay the exit.
	exitGrace = 200 * time.Millisecond
)

// token is read once from the environment; it is never printed or echoed.
var token string

// problemInfo mirrors src/model/problem.ts.
type problemInfo struct {
	code      int
	name      string
	category  string
	retryable bool
}

// Code table, see src/model/problem.ts.
var problems = map[string]problemInfo{
	"PARSE_ERROR":            {-32700, "PARSE_ERROR", "PROTOCOL", false},
	"INVALID_REQUEST":        {-32600, "INVALID_REQUEST", "PROTOCOL", false},
	"METHOD_NOT_FOUND":       {-32601, "METHOD_NOT_FOUND", "PROTOCOL", false},
	"INVALID_PARAMS":         {-32602, "INVALID_PARAMS", "PROTOCOL", false},
	"INTERNAL_ERROR":         {-32603, "INTERNAL_ERROR", "PROTOCOL", false},
	"ACCOUNT_NOT_BOUND":      {1005, "ACCOUNT_NOT_BOUND", "REJECTED", false},
	"INTERNAL":               {4001, "INTERNAL", "ENGINE", false},
	"BUSY":                   {4004, "BUSY", "ENGINE", true},
	"VERSION_UNSUPPORTED":    {5001, "VERSION_UNSUPPORTED", "PROTOCOL", false},
	"CAPABILITY_UNSUPPORTED": {5002, "CAPABILITY_UNSUPPORTED", "PROTOCOL", false},
	"AUTH_FAILED":            {5003, "AUTH_FAILED", "PROTOCOL", false},
	"SESSION_GAP":            {5004, "SESSION_GAP", "PROTOCOL", false},
	"SECRET_FIELD_REJECTED":  {5006, "SECRET_FIELD_REJECTED", "PROTOCOL", false},
	"PAYLOAD_TOO_LARGE":      {5007, "PAYLOAD_TOO_LARGE", "PROTOCOL", false},
}

// Optional method groups this engine does not declare.
var methodCapability = map[string]string{
	"strategy.list":    "strategy",
	"strategy.params":  "strategy",
	"strategy.start":   "strategy",
	"strategy.stop":    "strategy",
	"strategy.status":  "strategy",
	"strategy.update":  "strategy.hotUpdate",
	"backtest.run":     "backtest",
	"backtest.status":  "backtest",
	"backtest.result":  "backtest",
	"backtest.cancel":  "backtest",
	"replay.start":     "replay",
	"replay.stop":      "replay",
	"replay.status":    "replay",
	"order.place":      "execution.modeB",
	"order.amend":      "execution.modeB",
	"order.cancel":     "execution.modeB",
	"order.cancelAll":  "execution.modeB",
	"account.snapshot": "execution.modeB",
	"market.subscribe": "market.own",
	"market.snapshot":  "market.own",
	"market.history":   "market.own",
}

// capabilities is reported verbatim by engine.describe. No optional group is
// declared: this engine has no strategy, backtest, replay, own-market or mode B
// execution surface, and it never emits an event stream.
var capabilities = map[string]any{
	"execution.modeA":    true,
	"execution.modeB":    false,
	"market.useHost":     true,
	"market.own":         false,
	"strategy":           false,
	"strategy.hotUpdate": false,
	"backtest":           false,
	"replay":             false,
	"events.resume":      false,
	"risk.cooperative":   false,
	"halt.levels":        []any{"halt_new"},
	"builder.attach":     false,
	"decision.log":       false,
}

var secretFieldNames = map[string]bool{
	"privatekey": true,
	"secret":     true,
	"apisecret":  true,
	"mnemonic":   true,
	"seed":       true,
	"passphrase": true,
}

// rpcFault is a JSON-RPC level failure carrying a Problem name.
type rpcFault struct {
	name    string
	message string
}

func (f *rpcFault) Error() string { return f.message }

func fault(name, message string) *rpcFault { return &rpcFault{name: name, message: message} }

// conn is one stdio session: it owns the writer goroutine, the in-flight host.*
// calls and the shutdown state.
type conn struct {
	out chan []byte

	mu     sync.Mutex
	queued int

	pmu     sync.Mutex
	pending map[string]chan map[string]any
	hostSeq int

	authed         bool
	halt           map[string]any
	sessionCounter int
	sessionID      string

	xmu           sync.Mutex
	exitRequested bool
	exitCode      int
	exitDelay     time.Duration
}

func newConn() *conn {
	return &conn{out: make(chan []byte, 256), pending: map[string]chan map[string]any{}}
}

// send queues one frame for the writer goroutine.
func (c *conn) send(v any) {
	line, err := encode(v)
	if err != nil {
		return
	}
	c.mu.Lock()
	c.queued++
	c.mu.Unlock()
	c.out <- line
}

// writer is the only goroutine that touches stdout.
func (c *conn) writer() {
	w := bufio.NewWriter(os.Stdout)
	for line := range c.out {
		if _, err := w.Write(line); err == nil {
			_ = w.WriteByte('\n')
			_ = w.Flush()
		}
		c.mu.Lock()
		c.queued--
		c.mu.Unlock()
	}
}

// waitFlushed blocks until every queued frame has been written, or the deadline
// passes (the process is about to exit, so a stuck pipe is not worth hanging on).
func (c *conn) waitFlushed(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		n := c.queued
		c.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// callHost sends a host.* request and waits for its response (delivered by the
// reader goroutine). A timeout returns nil.
func (c *conn) callHost(method string, params any) any {
	c.pmu.Lock()
	c.hostSeq++
	hostID := "e" + strconv.Itoa(c.hostSeq)
	slot := make(chan map[string]any, 1)
	c.pending[hostID] = slot
	c.pmu.Unlock()

	c.send(map[string]any{"jsonrpc": "2.0", "id": hostID, "method": method, "params": params})

	select {
	case msg := <-slot:
		c.pmu.Lock()
		delete(c.pending, hostID)
		c.pmu.Unlock()
		return msg
	case <-time.After(hostCallTimeout):
		c.pmu.Lock()
		delete(c.pending, hostID)
		c.pmu.Unlock()
		return nil
	}
}

// resolveHostResponse is the reader side: hand a host.* response to the waiting
// worker. Returns false when the message is not a response we are waiting for.
func (c *conn) resolveHostResponse(v any) bool {
	msg, ok := v.(map[string]any)
	if !ok {
		return false
	}
	if _, isRequest := msg["method"]; isRequest {
		return false
	}
	id, hasID := msg["id"]
	if !hasID {
		return false
	}
	if _, hasResult := msg["result"]; !hasResult {
		if _, hasError := msg["error"]; !hasError {
			return false
		}
	}
	key, isText := id.(string)
	if !isText {
		return false
	}
	c.pmu.Lock()
	slot := c.pending[key]
	c.pmu.Unlock()
	if slot == nil {
		return false
	}
	slot <- msg
	return true
}

func (c *conn) exitAfter(code int, delay time.Duration) {
	c.xmu.Lock()
	c.exitRequested = true
	c.exitCode = code
	c.exitDelay = delay
	c.xmu.Unlock()
}

func (c *conn) exitState() (bool, int, time.Duration) {
	c.xmu.Lock()
	defer c.xmu.Unlock()
	return c.exitRequested, c.exitCode, c.exitDelay
}

// ---- Problem / envelope --------------------------------------------------------------

func nowMs() int64 { return time.Now().UnixMilli() }

func makeProblem(name, message string) map[string]any {
	info := problems[name]
	return map[string]any{
		"code":      info.code,
		"name":      info.name,
		"category":  info.category,
		"message":   message,
		"retryable": info.retryable,
	}
}

func errorResponse(id any, name, message string) map[string]any {
	problem := makeProblem(name, message)
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    problem["code"],
			"message": message,
			"data":    problem,
		},
	}
}

func encode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// ---- small JSON helpers --------------------------------------------------------------

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func isNumber(v any) bool {
	_, ok := v.(json.Number)
	return ok
}

func asInteger(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := strconv.ParseInt(n.String(), 10, 64)
	if err != nil {
		return 0, false
	}
	return i, true
}

func asFloat(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	if err != nil {
		return 0, false
	}
	return f, true
}

func isText(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && s != ""
}

func jsonText(v any) string {
	b, err := encode(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// ---- Secret-field rejection ----------------------------------------------------------

func normalizeKey(key string) string {
	return strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
}

// findSecretFields returns key paths only; secret values are never echoed or logged.
func findSecretFields(v any, path string, hits *[]string) {
	switch node := v.(type) {
	case []any:
		for i, item := range node {
			findSecretFields(item, path+"["+strconv.Itoa(i)+"]", hits)
		}
	case map[string]any:
		keys := make([]string, 0, len(node))
		for key := range node {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			item := node[key]
			normalized := normalizeKey(key)
			// A numeric `seed` directly under spec is an RNG seed, not a key.
			isRngSeed := normalized == "seed" && isNumber(item) && (path == "$.spec" || strings.HasSuffix(path, ".spec"))
			if secretFieldNames[normalized] && !isRngSeed {
				*hits = append(*hits, path+"."+key)
			}
			findSecretFields(item, path+"."+key, hits)
		}
	}
}

func secretHits(v any) []string {
	var hits []string
	findSecretFields(v, "$", &hits)
	return hits
}

// ---- Version negotiation -------------------------------------------------------------

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// majorMinor maps "0.1.0" to "0.1"; anything else is rejected.
func majorMinor(version string) (string, bool) {
	parts := strings.Split(version, ".")
	if len(parts) != 2 && len(parts) != 3 {
		return "", false
	}
	for _, p := range parts {
		if !allDigits(p) {
			return "", false
		}
	}
	return parts[0] + "." + parts[1], true
}

func versionRank(mm string) int {
	parts := strings.SplitN(mm, ".", 2)
	major, _ := strconv.Atoi(parts[0])
	minor := 0
	if len(parts) == 2 {
		minor, _ = strconv.Atoi(parts[1])
	}
	return major*1000 + minor
}

// negotiateVersion picks the highest MAJOR.MINOR both sides support.
func negotiateVersion(offered any) (string, bool) {
	list, ok := offered.([]any)
	if !ok {
		return "", false
	}
	var common []string
	for _, item := range list {
		text, isStr := item.(string)
		if !isStr {
			continue
		}
		mm, valid := majorMinor(text)
		if valid && mm == supportedV010 {
			common = append(common, mm)
		}
	}
	if len(common) == 0 {
		return "", false
	}
	sort.Slice(common, func(i, j int) bool { return versionRank(common[i]) < versionRank(common[j]) })
	return common[len(common)-1], true
}

// ---- Params validation ---------------------------------------------------------------

func bindingIssues(params any) []string {
	root, ok := params.(map[string]any)
	if !ok {
		return []string{"$ must be an object"}
	}
	var issues []string

	if _, good := isText(root["bindingId"]); !good {
		issues = append(issues, "$.bindingId must be a non-empty string")
	}

	accounts, isList := root["accounts"].([]any)
	if !isList || len(accounts) == 0 {
		issues = append(issues, "$.accounts must be a non-empty array")
	} else {
		for i, raw := range accounts {
			prefix := "$.accounts[" + strconv.Itoa(i) + "]"
			account, isObj := raw.(map[string]any)
			if !isObj {
				issues = append(issues, prefix+" must be an object")
				continue
			}
			if _, good := isText(account["accountId"]); !good {
				issues = append(issues, prefix+".accountId must be a non-empty string")
			}
			mode, _ := account["mode"].(string)
			if mode != "A" && mode != "B" {
				issues = append(issues, prefix+".mode must be A or B")
			}
			if _, good := isText(account["mandateId"]); !good {
				issues = append(issues, prefix+".mandateId must be a non-empty string")
			}
			if mode == "B" {
				signer, _ := account["signer"].(map[string]any)
				_, hasAddress := isText(signer["address"])
				_, hasFingerprint := isText(signer["fingerprint"])
				if signer == nil || (!hasAddress && !hasFingerprint) {
					issues = append(issues, prefix+".signer is required in mode B")
				}
			}
		}
	}

	data, isObj := root["data"].(map[string]any)
	if !isObj {
		issues = append(issues, "$.data must be an object")
	} else {
		source, _ := data["source"].(string)
		if source != "host" && source != "engine" {
			issues = append(issues, "$.data.source must be host or engine")
		}
		instruments, isArr := data["instruments"].([]any)
		allStrings := isArr
		if isArr {
			for _, item := range instruments {
				if _, isStr := item.(string); !isStr {
					allStrings = false
				}
			}
		} else {
			allStrings = false
		}
		if !allStrings {
			issues = append(issues, "$.data.instruments must be an array of strings")
		}
		if source == "engine" {
			issues = append(issues, "$.data.source engine requires market.own")
		}
	}

	policies, isList := root["policies"].([]any)
	if !isList {
		issues = append(issues, "$.policies must be an array")
	} else {
		for i, raw := range policies {
			prefix := "$.policies[" + strconv.Itoa(i) + "]"
			policy, isObj := raw.(map[string]any)
			if !isObj {
				issues = append(issues, prefix+" must be an object")
				continue
			}
			if _, good := isText(policy["policyId"]); !good {
				issues = append(issues, prefix+".policyId must be a non-empty string")
			}
			version, good := asInteger(policy["version"])
			if !good || version < 1 {
				issues = append(issues, prefix+".version must be an integer >= 1")
			}
			if _, good := isText(policy["digest"]); !good {
				issues = append(issues, prefix+".digest must be a non-empty string")
			}
		}
	}

	heartbeat, good := asInteger(root["heartbeatMs"])
	if !good || heartbeat < 100 {
		issues = append(issues, "$.heartbeatMs must be an integer >= 100")
	}

	return issues
}

// ---- Methods -------------------------------------------------------------------------

func describe() map[string]any {
	caps := make(map[string]any, len(capabilities))
	for k, v := range capabilities {
		caps[k] = v
	}
	return map[string]any{
		"engine": map[string]any{
			"id":      engineID,
			"name":    engineName,
			"version": engineVersion,
			"vendor": map[string]any{
				"id":       "gitrader",
				"name":     "Gitrader",
				"kind":     "community",
				"verified": false,
			},
			"license": "Apache-2.0",
			"runtime": "go",
		},
		"protocol":     map[string]any{"version": supportedV010, "transports": []any{"stdio"}},
		"capabilities": caps,
		"venues":       []any{},
		"data":         map[string]any{"intervals": []any{"1m", "5m"}, "maxHistoryBars": 5000},
		"limits":       map[string]any{"maxConcurrentBacktests": 0, "maxStrategyInstances": 0},
	}
}

type handlerFunc func(c *conn, params any) (any, *rpcFault)

func methodDescribe(_ *conn, _ any) (any, *rpcFault) { return describe(), nil }

func methodHealth(_ *conn, _ any) (any, *rpcFault) {
	return map[string]any{
		"status":  "ok",
		"metrics": map[string]any{"instances": 0, "bufferedEvents": 0},
		"ts":      nowMs(),
	}, nil
}

func methodSnapshot(_ *conn, _ any) (any, *rpcFault) {
	return map[string]any{"seq": 0, "strategies": []any{}, "orders": []any{}}, nil
}

func methodBind(c *conn, params any) (any, *rpcFault) {
	issues := bindingIssues(params)
	if len(issues) > 0 {
		return nil, fault("INVALID_PARAMS", "invalid binding: "+strings.Join(issues, "; "))
	}
	p := asMap(params)

	answer := c.callHost("host.describe", map[string]any{})
	host, _ := answer.(map[string]any)
	result, isObj := host["result"].(map[string]any)
	if !isObj {
		return nil, fault("INTERNAL", "host.describe did not answer")
	}

	known := map[string]bool{}
	if accounts, isList := result["accounts"].([]any); isList {
		for _, raw := range accounts {
			account, isObj := raw.(map[string]any)
			if !isObj {
				continue
			}
			if id, good := account["accountId"].(string); good {
				known[id] = true
			}
		}
	}

	// bindingIssues already guarantees a non-empty array of objects here.
	accounts := p["accounts"].([]any)
	for _, raw := range accounts {
		account := asMap(raw)
		accountID, _ := account["accountId"].(string)
		if !known[accountID] {
			return nil, fault("ACCOUNT_NOT_BOUND", "account is not known to the host")
		}
		if account["mode"] == "B" {
			return nil, fault("CAPABILITY_UNSUPPORTED", "execution.modeB is not declared")
		}
	}

	return map[string]any{"bindingId": p["bindingId"], "effective": p, "warnings": []any{}}, nil
}

func methodHalt(c *conn, params any) (any, *rpcFault) {
	p := asMap(params)
	takeoverID, hasID := isText(p["takeoverId"])
	level, _ := p["level"].(string)
	if !hasID || (level != "halt_new" && level != "cancel_all" && level != "flatten_all") {
		return nil, fault("INVALID_PARAMS", "takeoverId and level are required")
	}
	c.halt = map[string]any{"takeoverId": takeoverID, "level": level}
	return map[string]any{"ack": true, "appliedAt": nowMs()}, nil
}

func methodResume(c *conn, params any) (any, *rpcFault) {
	p := asMap(params)
	if c.halt == nil || p["takeoverId"] != c.halt["takeoverId"] {
		return nil, fault("INVALID_PARAMS", "unknown takeoverId")
	}
	c.halt = nil
	return map[string]any{"resumedAt": nowMs()}, nil
}

func methodShutdown(c *conn, params any) (any, *rpcFault) {
	grace, ok := asFloat(asMap(params)["graceMs"])
	if !ok || grace < 0 {
		grace = 0
	}
	delay := time.Duration(grace) * time.Millisecond
	if delay > exitGrace {
		delay = exitGrace
	}
	c.exitAfter(0, delay)
	return map[string]any{"ok": true}, nil
}

func methodEventsSubscribe(_ *conn, _ any) (any, *rpcFault) {
	return map[string]any{"subscriptionId": "sub_go_ref", "fromSeq": 1}, nil
}

func methodEventsUnsubscribe(_ *conn, _ any) (any, *rpcFault) {
	return map[string]any{"ok": true}, nil
}

func methodRiskPolicyPush(_ *conn, params any) (any, *rpcFault) {
	policies, isList := asMap(params)["policies"].([]any)
	if !isList {
		return nil, fault("INVALID_PARAMS", "policies must be an array")
	}
	versions := make([]any, 0, len(policies))
	for _, raw := range policies {
		policy, isObj := raw.(map[string]any)
		if !isObj {
			return nil, fault("INVALID_PARAMS", "policies must be objects")
		}
		version, good := asInteger(policy["version"])
		if !good {
			return nil, fault("INVALID_PARAMS", "policy version must be an integer")
		}
		versions = append(versions, version)
	}
	return map[string]any{"acceptedVersions": versions}, nil
}

var methods = map[string]handlerFunc{
	"engine.describe":    methodDescribe,
	"engine.bind":        methodBind,
	"engine.health":      methodHealth,
	"engine.snapshot":    methodSnapshot,
	"engine.halt":        methodHalt,
	"engine.resume":      methodResume,
	"engine.shutdown":    methodShutdown,
	"events.subscribe":   methodEventsSubscribe,
	"events.unsubscribe": methodEventsUnsubscribe,
	"risk.policy.push":   methodRiskPolicyPush,
}

func hello(c *conn, id any, params any) any {
	p := asMap(params)
	auth := asMap(p["auth"])
	presented, _ := auth["token"].(string)
	if presented != token {
		c.exitAfter(1, 50*time.Millisecond)
		return errorResponse(id, "AUTH_FAILED", "authentication failed")
	}

	version, ok := negotiateVersion(p["versions"])
	if !ok {
		return errorResponse(id, "VERSION_UNSUPPORTED",
			"no common version in "+jsonText(p["versions"])+"; supported: "+supportedV010)
	}

	if _, wantsResume := p["resume"].(map[string]any); wantsResume {
		// No event retention is declared, so a resume can never be completed.
		return errorResponse(id, "SESSION_GAP", "this engine does not retain events for resume")
	}

	c.authed = true
	c.sessionCounter++
	c.sessionID = "ses_goref" + fmt.Sprintf("%04d", c.sessionCounter)

	return map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result": map[string]any{
			"version":   version,
			"sessionId": c.sessionID,
			"resumed":   false,
			"engine":    map[string]any{"id": engineID, "version": engineVersion},
		},
	}
}

func capabilityDeclared(name string) bool {
	value, declared := capabilities[name]
	flag, isBool := value.(bool)
	return declared && isBool && flag
}

// dispatch handles one JSON-RPC value and returns the response, or nil for a
// notification. A panic anywhere below becomes an INTERNAL error, never a crash.
func dispatch(c *conn, value any) (response any) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintln(os.Stderr, "go-engine: internal dispatch failure")
			response = errorResponse(nil, "INTERNAL", "internal error")
		}
	}()

	msg, isObj := value.(map[string]any)
	if !isObj {
		return errorResponse(nil, "INVALID_REQUEST", "invalid request")
	}
	method, isMethod := msg["method"].(string)
	if msg["jsonrpc"] != "2.0" || !isMethod {
		return errorResponse(msg["id"], "INVALID_REQUEST", "invalid request")
	}
	id, hasID := msg["id"]
	if !hasID {
		// Host -> engine notifications are acknowledged by reading; nothing to do.
		return nil
	}

	if method == "gep.hello" {
		return hello(c, id, msg["params"])
	}
	if !c.authed {
		return errorResponse(id, "AUTH_FAILED", "hello required")
	}

	if hits := secretHits(msg["params"]); len(hits) > 0 {
		return errorResponse(id, "SECRET_FIELD_REJECTED", "secret-like field rejected: "+strings.Join(hits, ", "))
	}
	if capability, gated := methodCapability[method]; gated && !capabilityDeclared(capability) {
		return errorResponse(id, "CAPABILITY_UNSUPPORTED", method+" is not declared in engine.describe")
	}

	handler, known := methods[method]
	if !known {
		return errorResponse(id, "METHOD_NOT_FOUND", "method not found: "+method)
	}

	params := msg["params"]
	if params == nil {
		params = map[string]any{}
	}
	result, failure := handler(c, params)
	if failure != nil {
		return errorResponse(id, failure.name, failure.message)
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

// ---- stdio plumbing ------------------------------------------------------------------

// parseLine decodes one stdio line. Returns ok=false (after emitting the right
// error frame) when the line is unusable.
func parseLine(c *conn, raw []byte) (any, bool) {
	line := bytes.TrimSpace(raw)
	if len(line) == 0 {
		return nil, false
	}
	line = bytes.TrimPrefix(line, []byte{0xEF, 0xBB, 0xBF})
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return nil, false
	}
	if len(line) > maxLineBytes {
		c.send(errorResponse(nil, "PAYLOAD_TOO_LARGE", "stdio line exceeds 1 MiB"))
		return nil, false
	}
	if !utf8.Valid(line) {
		c.send(errorResponse(nil, "PARSE_ERROR", "invalid UTF-8"))
		return nil, false
	}
	if !json.Valid(line) {
		c.send(errorResponse(nil, "PARSE_ERROR", "parse error"))
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		c.send(errorResponse(nil, "PARSE_ERROR", "parse error"))
		return nil, false
	}
	return value, true
}

// readLoop is the reader goroutine: stdin -> inbox. It never blocks on the inbox
// for long, so a worker waiting on a host.* response can always be answered.
func readLoop(c *conn, inbox chan<- any) {
	reader := bufio.NewReaderSize(os.Stdin, 64*1024)
	var backlog []any

	hand := func(value any) {
		if len(backlog) == 0 {
			select {
			case inbox <- value:
				return
			default:
			}
		}
		backlog = append(backlog, value)
		for len(backlog) > 0 {
			select {
			case inbox <- backlog[0]:
				backlog = backlog[1:]
			default:
				return
			}
		}
	}

	for {
		raw, err := reader.ReadBytes('\n')
		if len(raw) > 0 {
			if value, ok := parseLine(c, raw); ok {
				if !c.resolveHostResponse(value) {
					hand(value)
				}
			}
		}
		if err != nil {
			break
		}
	}

	for _, value := range backlog {
		inbox <- value
	}
	close(inbox)
}

// workLoop is the worker goroutine: inbox -> dispatch -> writer channel.
func workLoop(c *conn, inbox <-chan any) {
	for message := range inbox {
		if batch, isBatch := message.([]any); isBatch {
			out := make([]any, 0, len(batch))
			for _, item := range batch {
				if response := dispatch(c, item); response != nil {
					out = append(out, response)
				}
			}
			if len(out) > 0 {
				c.send(out)
			}
		} else if response := dispatch(c, message); response != nil {
			c.send(response)
		}

		if requested, code, delay := c.exitState(); requested {
			time.Sleep(delay)
			c.waitFlushed(time.Second)
			os.Exit(code)
		}
	}
}

func main() {
	token = os.Getenv(tokenEnv)
	if token == "" {
		fmt.Fprintf(os.Stderr, "go-engine: %s is not set; refusing to start\n", tokenEnv)
		os.Exit(2)
	}

	c := newConn()
	inbox := make(chan any, 64)
	done := make(chan struct{})

	go c.writer()
	go func() {
		workLoop(c, inbox)
		close(done)
	}()

	readLoop(c, inbox)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
	c.waitFlushed(time.Second)
	os.Exit(0)
}
