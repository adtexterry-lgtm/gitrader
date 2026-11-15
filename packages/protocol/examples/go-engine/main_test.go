// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the Go reference engine: framing, version negotiation,
// the auth handshake, secret-field rejection and batch id correspondence.
// No network, no subprocess, no filesystem.
package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const testToken = "unit-test-token"

// useToken installs the engine token for the duration of one test.
func useToken(t *testing.T) {
	t.Helper()
	previous := token
	token = testToken
	t.Cleanup(func() { token = previous })
}

// nextJSON takes the next frame the engine queued for stdout.
func nextJSON(t *testing.T, c *conn) any {
	t.Helper()
	select {
	case line := <-c.out:
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.UseNumber()
		var value any
		if err := dec.Decode(&value); err != nil {
			t.Fatalf("queued frame is not valid JSON: %v (%q)", err, string(line))
		}
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("no frame was queued within 2 s")
		return nil
	}
}

func expectNoFrame(t *testing.T, c *conn) {
	t.Helper()
	select {
	case line := <-c.out:
		t.Fatalf("unexpected frame: %q", string(line))
	case <-time.After(50 * time.Millisecond):
	}
}

// problemOf pulls the Problem out of an error response.
func problemOf(t *testing.T, response any) (code int, message string, problem map[string]any) {
	t.Helper()
	envelope, ok := response.(map[string]any)
	if !ok {
		t.Fatalf("response is not an object: %#v", response)
	}
	raw, hasError := envelope["error"].(map[string]any)
	if !hasError {
		t.Fatalf("expected an error response, got %#v", response)
	}
	number := 0
	switch n := raw["code"].(type) {
	case json.Number:
		parsed, err := n.Int64()
		if err != nil {
			t.Fatalf("error.code is not an integer: %v", err)
		}
		number = int(parsed)
	case int:
		number = n
	case float64:
		number = int(n)
	default:
		t.Fatalf("error.code is not a number: %#v", raw["code"])
	}
	text, _ := raw["message"].(string)
	data, _ := raw["data"].(map[string]any)
	return number, text, data
}

func request(id int, method string, params any) map[string]any {
	msg := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	return msg
}

// T01 in miniature: one JSON value per line, object or array, bad lines rejected.
func TestFrameParsing(t *testing.T) {
	c := newConn()

	object, ok := parseLine(c, []byte(`{"jsonrpc":"2.0","id":1,"method":"engine.health"}`))
	if !ok {
		t.Fatal("a well-formed request must parse")
	}
	if method, _ := asMap(object)["method"].(string); method != "engine.health" {
		t.Fatalf("object frame lost its method: %#v", object)
	}

	array, ok := parseLine(c, []byte("\r\n"+"[{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"engine.health\"},{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"engine.describe\"}]\r\n"))
	if !ok {
		t.Fatal("a batch frame must parse")
	}
	batch, isBatch := array.([]any)
	if !isBatch || len(batch) != 2 {
		t.Fatalf("batch frame must decode to a 2-element array, got %#v", array)
	}

	// A UTF-8 BOM is stripped, not treated as a parse error.
	bom, ok := parseLine(c, []byte("\xef\xbb\xbf{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"engine.health\"}"))
	if !ok {
		t.Fatal("a BOM-prefixed line must parse")
	}
	if id, _ := asMap(bom)["id"].(json.Number); id.String() != "4" {
		t.Fatalf("BOM frame lost its id: %#v", bom)
	}

	expectNoFrame(t, c) // valid frames queue nothing

	if _, ok := parseLine(c, []byte(`{"jsonrpc":"2.0",`)); ok {
		t.Fatal("a truncated line must be rejected")
	}
	code, message, problem := problemOf(t, nextJSON(t, c))
	if code != -32700 || problem["name"] != "PARSE_ERROR" || problem["category"] != "PROTOCOL" {
		t.Fatalf("bad line must be PARSE_ERROR (-32700), got %d %v", code, problem)
	}
	if message != "parse error" {
		t.Fatalf("unexpected parse message: %q", message)
	}

	if _, ok := parseLine(c, []byte{0xff, 0xfe, 0x7b, 0x7d}); ok {
		t.Fatal("invalid UTF-8 must be rejected")
	}
	code, _, _ = problemOf(t, nextJSON(t, c))
	if code != -32700 {
		t.Fatalf("invalid UTF-8 must be PARSE_ERROR, got %d", code)
	}

	if _, ok := parseLine(c, make([]byte, maxLineBytes+1)); ok {
		t.Fatal("an oversized line must be rejected")
	}
	code, _, _ = problemOf(t, nextJSON(t, c))
	if code != 5007 {
		t.Fatalf("oversized line must be PAYLOAD_TOO_LARGE (5007), got %d", code)
	}
}

// T02: ["0.1"] negotiates 0.1, ["9.9"] is unsupported, a mixed list picks 0.1.
func TestVersionNegotiation(t *testing.T) {
	useToken(t)

	if version, ok := negotiateVersion([]any{"0.1"}); !ok || version != "0.1" {
		t.Fatalf("[0.1] must negotiate 0.1, got %q ok=%v", version, ok)
	}
	if version, ok := negotiateVersion([]any{"9.9", "0.1.7"}); !ok || version != "0.1" {
		t.Fatalf("a mixed offer must negotiate 0.1, got %q ok=%v", version, ok)
	}
	if _, ok := negotiateVersion([]any{"9.9"}); ok {
		t.Fatal("[9.9] must not negotiate a version")
	}
	if _, ok := negotiateVersion("0.1"); ok {
		t.Fatal("a non-array offer must not negotiate a version")
	}

	good := newConn()
	response, isObj := dispatch(good, request(1, "gep.hello", map[string]any{
		"versions": []any{"0.1"}, "auth": map[string]any{"token": testToken},
	})).(map[string]any)
	if !isObj {
		t.Fatalf("gep.hello must answer with an object: %#v", response)
	}
	result := asMap(response["result"])
	if result["version"] != "0.1" || result["resumed"] != false {
		t.Fatalf("unexpected hello result: %#v", result)
	}
	if sessionID, _ := result["sessionId"].(string); !strings.HasPrefix(sessionID, "ses_") {
		t.Fatalf("sessionId must look like ses_…: %#v", result["sessionId"])
	}
	if !good.authed {
		t.Fatal("hello must authenticate the session")
	}

	bad := newConn()
	code, _, problem := problemOf(t, dispatch(bad, request(2, "gep.hello", map[string]any{
		"versions": []any{"9.9"}, "auth": map[string]any{"token": testToken},
	})))
	if code != 5001 {
		t.Fatalf("[9.9] must answer 5001 (VERSION_UNSUPPORTED), got %d", code)
	}
	if problem["category"] != "PROTOCOL" {
		t.Fatalf("5001 must be a PROTOCOL problem, got %v", problem["category"])
	}
	if bad.authed {
		t.Fatal("a failed negotiation must not authenticate the session")
	}
}

// T03: a wrong token answers 5003 and asks the process to exit non-zero.
func TestWrongTokenIsRejected(t *testing.T) {
	useToken(t)

	c := newConn()
	code, message, problem := problemOf(t, dispatch(c, request(7, "gep.hello", map[string]any{
		"versions": []any{"0.1"}, "auth": map[string]any{"token": testToken + "-wrong"},
	})))
	if code != 5003 || problem["name"] != "AUTH_FAILED" {
		t.Fatalf("a wrong token must answer 5003, got %d %v", code, problem)
	}
	if strings.Contains(message, testToken) {
		t.Fatalf("the auth error must not echo the token: %q", message)
	}
	requested, exitCode, delay := c.exitState()
	if !requested || exitCode != 1 {
		t.Fatalf("a failed hello must exit with code 1, got requested=%v code=%d", requested, exitCode)
	}
	if delay > time.Second {
		t.Fatalf("the exit must not wait longer than 1 s, got %v", delay)
	}

	// No hello at all: every other method is refused too.
	anonymous := newConn()
	if code, _, _ := problemOf(t, dispatch(anonymous, request(8, "engine.describe", nil))); code != 5003 {
		t.Fatalf("calling before hello must answer 5003, got %d", code)
	}
}

// T14: secret-like fields are rejected with 5006 and the value is never echoed.
func TestSecretFieldRejected(t *testing.T) {
	useToken(t)
	const canary = "CANARY-do-not-echo-42"

	cases := []struct {
		name   string
		method string
		params any
	}{
		{"top level", "engine.health", map[string]any{"privateKey": canary}},
		{"nested", "engine.health", map[string]any{"nested": map[string]any{"deep": map[string]any{"apiSecret": canary}}}},
		{"camel and underscores", "engine.bind", map[string]any{"api_secret": canary}},
		{"in an array", "risk.policy.push", map[string]any{"policies": []any{map[string]any{"mnemonic": canary}}}},
		{"passphrase", "events.subscribe", map[string]any{"passphrase": canary}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newConn()
			c.authed = true
			response := dispatch(c, request(11, tc.method, tc.params))
			code, message, problem := problemOf(t, response)
			if code != 5006 || problem["name"] != "SECRET_FIELD_REJECTED" {
				t.Fatalf("secret field must answer 5006, got %d %v", code, problem)
			}
			if strings.Contains(message, canary) {
				t.Fatalf("the secret value must never be echoed: %q", message)
			}
			if encoded, err := encode(response); err == nil && strings.Contains(string(encoded), canary) {
				t.Fatalf("the secret value leaked into the response frame: %s", encoded)
			}
			if !strings.Contains(message, "$") {
				t.Fatalf("the error should name the offending field path: %q", message)
			}
		})
	}

	// A numeric seed directly under spec is an RNG seed, not a secret.
	c := newConn()
	c.authed = true
	response := dispatch(c, request(12, "engine.health", map[string]any{"spec": map[string]any{"seed": json.Number("42")}}))
	if _, hasError := asMap(response)["error"]; hasError {
		t.Fatalf("a numeric spec.seed must not be treated as a secret: %#v", response)
	}
}

// T04/T05: describe is honest — the Go engine declares no optional group.
func TestDescribeDeclaresNoOptionalCapabilities(t *testing.T) {
	useToken(t)

	c := newConn()
	c.authed = true
	response := asMap(dispatch(c, request(21, "engine.describe", nil)))
	result := asMap(response["result"])
	engine := asMap(result["engine"])

	if engine["id"] != "go-reference" {
		t.Fatalf("engine.describe id must be go-reference, got %v", engine["id"])
	}
	if engine["name"] != "Go reference engine (protocol example)" {
		t.Fatalf("unexpected engine name: %v", engine["name"])
	}
	if engine["license"] != "Apache-2.0" || engine["runtime"] != "go" {
		t.Fatalf("unexpected engine identity: %#v", engine)
	}

	caps := asMap(result["capabilities"])
	for _, key := range []string{"execution.modeB", "market.own", "strategy", "strategy.hotUpdate", "backtest", "replay", "events.resume", "risk.cooperative", "builder.attach", "decision.log"} {
		if caps[key] != false {
			t.Fatalf("capability %s must be false for a non-trading example, got %#v", key, caps[key])
		}
	}
	if caps["execution.modeA"] != true || caps["market.useHost"] != true {
		t.Fatalf("mode A and host market must be declared: %#v", caps)
	}
	if levels, isList := caps["halt.levels"].([]any); !isList || len(levels) != 1 || levels[0] != "halt_new" {
		t.Fatalf("halt.levels must be [halt_new], got %#v", caps["halt.levels"])
	}
	if protocol := asMap(result["protocol"]); protocol["version"] != "0.1" {
		t.Fatalf("protocol.version must be 0.1, got %v", protocol["version"])
	}

	// Every optional method is refused, never silently accepted.
	for method := range methodCapability {
		code, _, _ := problemOf(t, dispatch(c, request(22, method, map[string]any{})))
		if code != 5002 && code != -32601 {
			t.Fatalf("%s must answer 5002 or -32601 without its capability, got %d", method, code)
		}
	}
	if code, _, _ := problemOf(t, dispatch(c, request(23, "x-nothing.here", map[string]any{}))); code != -32601 {
		t.Fatalf("an unknown method must answer -32601, got %d", code)
	}
}

// T01 batch rule: one line in, one array line out, ids corresponding one to one.
func TestBatchResponsesKeepOneToOneIDs(t *testing.T) {
	useToken(t)

	c := newConn()
	c.authed = true
	inbox := make(chan any, 1)
	done := make(chan struct{})
	go func() {
		workLoop(c, inbox)
		close(done)
	}()

	inbox <- []any{
		request(31, "engine.health", nil),
		request(32, "engine.snapshot", nil),
		request(33, "no.such.method", map[string]any{}),
	}
	close(inbox)
	<-done

	frame, isList := nextJSON(t, c).([]any)
	if !isList {
		t.Fatalf("a batch must be answered with an array, got %#v", frame)
	}
	if len(frame) != 3 {
		t.Fatalf("3 requests must produce 3 responses, got %d", len(frame))
	}
	for index, want := range []string{"31", "32", "33"} {
		envelope := asMap(frame[index])
		id, _ := envelope["id"].(json.Number)
		if id.String() != want {
			t.Fatalf("response %d must carry id %s, got %v", index, want, envelope["id"])
		}
	}
	if _, hasResult := asMap(frame[0])["result"]; !hasResult {
		t.Fatalf("engine.health must succeed: %#v", frame[0])
	}
	if code, _, _ := problemOf(t, frame[2]); code != -32601 {
		t.Fatalf("an unknown method in a batch must answer -32601, got %d", code)
	}

	// A notification (no id) is never answered.
	quiet := newConn()
	quiet.authed = true
	notifications := make(chan any, 1)
	notified := make(chan struct{})
	go func() {
		workLoop(quiet, notifications)
		close(notified)
	}()
	notifications <- map[string]any{"jsonrpc": "2.0", "method": "gep.heartbeat", "params": map[string]any{"ts": nowMs()}}
	close(notifications)
	<-notified
	expectNoFrame(t, quiet)
}
