using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using TrafficRecorder.Models;

namespace TrafficRecorder
{
    static class DebugConsole
    {
#if DEBUG
        public static void WriteLine(string message) => Console.WriteLine(message);
        public static void WriteLine(string format, params object[] args) => Console.WriteLine(format, args);
#else
        public static void WriteLine(string message) { }
        public static void WriteLine(string format, params object[] args) { }
#endif
    }

    class Program
    {
        // Configuration
        const string ServerEndpoint = "http://localhost:3000/api/capture";
        const string CommandsEndpoint = "http://localhost:3000/api/commands";
        const string CommandResultEndpoint = "http://localhost:3000/api/command-result";
        const string CdpEndpoint = "http://localhost:8181";
        const string ServerHost = "localhost:3000";

        static BrowserConnection _browserConnection;
        static volatile bool Running = true;

        static void Main(string[] args)
        {
            DebugConsole.WriteLine("=== Remote Traffic Recorder (Browser-Level CDP) ===");
            DebugConsole.WriteLine($"CDP Endpoint: {CdpEndpoint}");
            DebugConsole.WriteLine($"Server Endpoint: {ServerEndpoint}");
            DebugConsole.WriteLine("");

            Console.CancelKeyPress += (s, e) => { e.Cancel = true; Running = false; };

            try
            {
                DebugConsole.WriteLine("Connecting to browser...\n");
                _browserConnection = new BrowserConnection(CdpEndpoint, ServerHost, SendToServer);
                var browserTask = _browserConnection.StartAsync();
                var commandTask = RunCommandLoop();
                Task.WhenAny(browserTask, commandTask).Wait();
            }
            catch (AggregateException ex)
            {
                foreach (var inner in ex.InnerExceptions)
                {
                    if (!(inner is TaskCanceledException))
                        DebugConsole.WriteLine($"[ERROR] {inner.Message}");
                }
            }
            catch (Exception ex)
            {
                DebugConsole.WriteLine($"[ERROR] {ex.Message}");
            }

            DebugConsole.WriteLine("\nShutting down...");
        }

        static void SendToServer(CapturedTransaction transaction)
        {
            Task.Run(() =>
            {
                try
                {
                    var json = JsonConvert.SerializeObject(transaction);
                    using (var client = new WebClient())
                    {
                        client.Headers[HttpRequestHeader.ContentType] = "application/json";
                        client.UploadString(ServerEndpoint, json);
                    }
                }
                catch (Exception ex)
                {
                    DebugConsole.WriteLine($"[ERROR] Send failed: {ex.Message}");
                }
            });
        }

        static async Task RunCommandLoop()
        {
            using (var httpClient = new WebClient())
            {
                while (Running)
                {
                    try
                    {
                        var json = httpClient.DownloadString(CommandsEndpoint);
                        if (!string.IsNullOrEmpty(json) && json != "null")
                        {
                            var command = JObject.Parse(json);
                            await ProcessCommand(command);
                        }
                    }
                    catch (Exception ex)
                    {
                        if (!Running) break;
                        DebugConsole.WriteLine($"[WARN] Command poll: {ex.Message}");
                    }

                    await Task.Delay(500);
                }
            }
        }

        static async Task ProcessCommand(JObject command)
        {
            var id = command["id"]?.Value<int>() ?? 0;
            var type = command["type"]?.ToString();

            DebugConsole.WriteLine($"[CMD] Processing {type} (id: {id})");

            if (type == "getTargets")
            {
                var targets = _browserConnection.GetTargets();
                SendCommandResult(id, type, targets, null);
                return;
            }

            var targetId = command["targetId"]?.ToString();
            var sessionId = _browserConnection.GetSessionForTarget(targetId);

            if (string.IsNullOrEmpty(sessionId))
            {
                // Try first available session
                sessionId = _browserConnection.GetFirstSession();
            }

            if (string.IsNullOrEmpty(sessionId))
            {
                SendCommandResult(id, type, null, "No active browser sessions");
                return;
            }

            try
            {
                JToken result = null;
                if (type == "getCookies")
                {
                    result = await _browserConnection.SendSessionCommandAsync(sessionId, "Network.getAllCookies", null);
                }
                else if (type == "executeJs")
                {
                    var code = command["code"]?.ToString();
                    var evalParams = new Dictionary<string, object>
                    {
                        ["expression"] = code,
                        ["returnByValue"] = true
                    };
                    result = await _browserConnection.SendSessionCommandAsync(sessionId, "Runtime.evaluate", evalParams);
                }

                SendCommandResult(id, type, result, null);
            }
            catch (Exception ex)
            {
                SendCommandResult(id, type, null, ex.Message);
            }
        }

        static void SendCommandResult(int id, string type, JToken result, string error)
        {
            Task.Run(() =>
            {
                try
                {
                    var payload = new JObject
                    {
                        ["id"] = id,
                        ["type"] = type
                    };
                    if (error != null)
                        payload["error"] = error;
                    else
                        payload["result"] = result;

                    using (var client = new WebClient())
                    {
                        client.Headers[HttpRequestHeader.ContentType] = "application/json";
                        client.UploadString(CommandResultEndpoint, payload.ToString());
                    }
                    DebugConsole.WriteLine($"[CMD] Sent result for {type} (id: {id})");
                }
                catch (Exception ex)
                {
                    DebugConsole.WriteLine($"[ERROR] Command result send failed: {ex.Message}");
                }
            });
        }
    }

    /// <summary>
    /// Browser-level CDP connection using flattened sessions.
    /// This maintains a single WebSocket to the browser and automatically attaches to all page targets.
    /// Sessions survive page navigation, so we don't lose requests.
    /// </summary>
    class BrowserConnection
    {
        private readonly string _cdpEndpoint;
        private readonly string _serverHost;
        private readonly Action<CapturedTransaction> _sendToServer;
        private ClientWebSocket _ws;
        private int _msgId = 0;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);

        // Session tracking: sessionId -> SessionInfo
        private readonly ConcurrentDictionary<string, SessionInfo> _sessions = new ConcurrentDictionary<string, SessionInfo>();

        // Target to session mapping: targetId -> sessionId
        private readonly ConcurrentDictionary<string, string> _targetToSession = new ConcurrentDictionary<string, string>();

        // Pending commands waiting for response
        private readonly ConcurrentDictionary<int, TaskCompletionSource<JToken>> _pendingCommands = new ConcurrentDictionary<int, TaskCompletionSource<JToken>>();

        private class SessionInfo
        {
            public string TargetId;
            public string Url;
            public ConcurrentDictionary<string, RequestData> PendingRequests = new ConcurrentDictionary<string, RequestData>();
            public ConcurrentDictionary<string, ResponseInfo> ResponseInfos = new ConcurrentDictionary<string, ResponseInfo>();
        }

        private class ResponseInfo
        {
            public int Status;
            public Dictionary<string, string> Headers;
            public string MimeType;
        }

        public BrowserConnection(string cdpEndpoint, string serverHost, Action<CapturedTransaction> sendToServer)
        {
            _cdpEndpoint = cdpEndpoint;
            _serverHost = serverHost;
            _sendToServer = sendToServer;
        }

        public JArray GetTargets()
        {
            var targets = new JArray();
            foreach (var kvp in _sessions)
            {
                targets.Add(new JObject
                {
                    ["id"] = kvp.Value.TargetId,
                    ["url"] = kvp.Value.Url
                });
            }
            return targets;
        }

        public string GetSessionForTarget(string targetId)
        {
            if (string.IsNullOrEmpty(targetId)) return null;
            string sessionId;
            _targetToSession.TryGetValue(targetId, out sessionId);
            return sessionId;
        }

        public string GetFirstSession()
        {
            foreach (var kvp in _sessions)
                return kvp.Key;
            return null;
        }

        public async Task StartAsync()
        {
            // Get browser WebSocket URL from /json/version
            string browserWsUrl;
            using (var client = new WebClient())
            {
                var versionJson = client.DownloadString($"{_cdpEndpoint}/json/version");
                var version = JObject.Parse(versionJson);
                browserWsUrl = version["webSocketDebuggerUrl"]?.ToString();
            }

            if (string.IsNullOrEmpty(browserWsUrl))
            {
                DebugConsole.WriteLine("[ERROR] Could not get browser WebSocket URL");
                return;
            }

            DebugConsole.WriteLine($"[BROWSER] Connecting to: {browserWsUrl}");

            _ws = new ClientWebSocket();
            await _ws.ConnectAsync(new Uri(browserWsUrl), CancellationToken.None);
            DebugConsole.WriteLine("[BROWSER] Connected to browser");

            // Enable auto-attach to all targets with flattened sessions
            await SendCommandAsync("Target.setAutoAttach", new Dictionary<string, object>
            {
                ["autoAttach"] = true,
                ["waitForDebuggerOnStart"] = false,
                ["flatten"] = true
            });
            DebugConsole.WriteLine("[BROWSER] Auto-attach enabled");

            // Discover existing targets
            await SendCommandAsync("Target.setDiscoverTargets", new Dictionary<string, object>
            {
                ["discover"] = true
            });
            DebugConsole.WriteLine("[BROWSER] Target discovery enabled");

            // Receive loop
            var buffer = new byte[1024 * 1024];
            var messageBuffer = new MemoryStream();

            while (_ws.State == WebSocketState.Open)
            {
                try
                {
                    var result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);

                    if (result.MessageType == WebSocketMessageType.Close)
                        break;

                    messageBuffer.Write(buffer, 0, result.Count);

                    if (result.EndOfMessage)
                    {
                        var message = Encoding.UTF8.GetString(messageBuffer.ToArray());
                        messageBuffer.SetLength(0);
                        ProcessMessage(message);
                    }
                }
                catch (WebSocketException ex)
                {
                    DebugConsole.WriteLine($"[BROWSER] WebSocket error: {ex.Message}");
                    break;
                }
            }

            DebugConsole.WriteLine("[BROWSER] Disconnected");
        }

        private async Task<JToken> SendCommandAsync(string method, object parameters)
        {
            return await SendCommandInternalAsync(method, parameters, null);
        }

        public async Task<JToken> SendSessionCommandAsync(string sessionId, string method, object parameters)
        {
            return await SendCommandInternalAsync(method, parameters, sessionId);
        }

        private async Task<JToken> SendCommandInternalAsync(string method, object parameters, string sessionId)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return null;

            var id = Interlocked.Increment(ref _msgId);
            var tcs = new TaskCompletionSource<JToken>();
            _pendingCommands[id] = tcs;

            var msg = new Dictionary<string, object>
            {
                ["id"] = id,
                ["method"] = method,
                ["params"] = parameters ?? new Dictionary<string, object>()
            };

            if (!string.IsNullOrEmpty(sessionId))
            {
                msg["sessionId"] = sessionId;
            }

            var json = JsonConvert.SerializeObject(msg);
            var bytes = Encoding.UTF8.GetBytes(json);

            // Serialize WebSocket sends to avoid concurrent SendAsync calls
            await _sendLock.WaitAsync();
            try
            {
                if (_ws.State == WebSocketState.Open)
                {
                    await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
                }
            }
            finally
            {
                _sendLock.Release();
            }

            var timeoutTask = Task.Delay(5000);
            var completedTask = await Task.WhenAny(tcs.Task, timeoutTask);

            TaskCompletionSource<JToken> removed;
            _pendingCommands.TryRemove(id, out removed);

            if (completedTask == tcs.Task)
                return await tcs.Task;

            return null;
        }

        private void ProcessMessage(string message)
        {
            try
            {
                var root = JObject.Parse(message);

                // Handle command responses
                var idToken = root["id"];
                if (idToken != null)
                {
                    var id = idToken.Value<int>();
                    TaskCompletionSource<JToken> tcs;
                    if (_pendingCommands.TryGetValue(id, out tcs))
                    {
                        var result = root["result"];
                        tcs.TrySetResult(result ?? JValue.CreateNull());
                    }
                    return;
                }

                // Handle events
                var methodToken = root["method"];
                if (methodToken == null) return;
                var method = methodToken.ToString();
                var paramsEl = root["params"];
                var sessionId = root["sessionId"]?.ToString();

                switch (method)
                {
                    case "Target.attachedToTarget":
                        HandleAttachedToTarget(paramsEl);
                        break;
                    case "Target.detachedFromTarget":
                        HandleDetachedFromTarget(paramsEl);
                        break;
                    case "Target.targetInfoChanged":
                        HandleTargetInfoChanged(paramsEl);
                        break;
                    case "Network.requestWillBeSent":
                        if (sessionId != null) HandleRequestWillBeSent(sessionId, paramsEl);
                        break;
                    case "Network.responseReceived":
                        if (sessionId != null) HandleResponseReceived(sessionId, paramsEl);
                        break;
                    case "Network.loadingFinished":
                        if (sessionId != null) HandleLoadingFinished(sessionId, paramsEl);
                        break;
                    case "Network.loadingFailed":
                        if (sessionId != null) HandleLoadingFailed(sessionId, paramsEl);
                        break;
                }
            }
            catch (Exception ex)
            {
                DebugConsole.WriteLine($"[ERROR] ProcessMessage: {ex.Message}");
            }
        }

        private void HandleAttachedToTarget(JToken p)
        {
            var sessionId = p["sessionId"]?.ToString();
            var targetInfo = p["targetInfo"];
            if (sessionId == null || targetInfo == null) return;

            var targetType = targetInfo["type"]?.ToString();
            var targetId = targetInfo["targetId"]?.ToString();
            var url = targetInfo["url"]?.ToString() ?? "";

            // Only monitor page targets, skip our own server
            if (targetType != "page" || url.Contains(_serverHost))
            {
                return;
            }

            DebugConsole.WriteLine($"[+] Attached: {url} (session: {sessionId.Substring(0, 8)}...)");

            var session = new SessionInfo
            {
                TargetId = targetId,
                Url = url
            };
            _sessions[sessionId] = session;
            _targetToSession[targetId] = sessionId;

            // Enable network monitoring for this session
            Task.Run(async () =>
            {
                try
                {
                    await SendSessionCommandAsync(sessionId, "Network.enable", new Dictionary<string, object>
                    {
                        ["maxPostDataSize"] = 1024 * 1024
                    });
                    DebugConsole.WriteLine($"[CDP] Network enabled for session {sessionId.Substring(0, 8)}...");
                }
                catch (Exception ex)
                {
                    DebugConsole.WriteLine($"[ERROR] Failed to enable network for session: {ex.Message}");
                }
            });
        }

        private void HandleDetachedFromTarget(JToken p)
        {
            var sessionId = p["sessionId"]?.ToString();
            if (sessionId == null) return;

            SessionInfo session;
            if (_sessions.TryRemove(sessionId, out session))
            {
                DebugConsole.WriteLine($"[-] Detached: {session.Url}");

                // Remove target mapping
                string removed;
                _targetToSession.TryRemove(session.TargetId, out removed);

                // Flush any pending requests for this session
                FlushPendingRequests(session);
            }
        }

        private void HandleTargetInfoChanged(JToken p)
        {
            var targetInfo = p["targetInfo"];
            if (targetInfo == null) return;

            var targetId = targetInfo["targetId"]?.ToString();
            var newUrl = targetInfo["url"]?.ToString() ?? "";

            // Update URL in session info (navigation happened but session stayed)
            string sessionId;
            if (_targetToSession.TryGetValue(targetId, out sessionId))
            {
                SessionInfo session;
                if (_sessions.TryGetValue(sessionId, out session))
                {
                    if (session.Url != newUrl)
                    {
                        DebugConsole.WriteLine($"[NAV] {session.Url} -> {newUrl}");
                        session.Url = newUrl;
                    }
                }
            }
        }

        private void HandleRequestWillBeSent(string sessionId, JToken p)
        {
            SessionInfo session;
            if (!_sessions.TryGetValue(sessionId, out session)) return;

            var requestId = p["requestId"]?.ToString();
            if (requestId == null) return;

            var request = p["request"];
            if (request == null) return;

            var url = request["url"]?.ToString() ?? "";
            if (url.Contains(_serverHost)) return;

            var headers = new Dictionary<string, string>();
            var headersToken = request["headers"];
            if (headersToken != null)
            {
                foreach (var prop in headersToken.Children<JProperty>())
                    headers[prop.Name] = prop.Value?.ToString() ?? "";
            }

            var reqData = new RequestData
            {
                Url = url,
                Method = request["method"]?.ToString() ?? "GET",
                Headers = headers,
                Body = request["postData"]?.ToString()
            };

            session.PendingRequests[requestId] = reqData;
            DebugConsole.WriteLine($"[REQ] {reqData.Method} {url}");
        }

        private void HandleResponseReceived(string sessionId, JToken p)
        {
            SessionInfo session;
            if (!_sessions.TryGetValue(sessionId, out session)) return;

            var requestId = p["requestId"]?.ToString();
            if (requestId == null) return;

            var response = p["response"];
            if (response == null) return;

            var headers = new Dictionary<string, string>();
            var headersToken = response["headers"];
            if (headersToken != null)
            {
                foreach (var prop in headersToken.Children<JProperty>())
                    headers[prop.Name] = prop.Value?.ToString() ?? "";
            }

            var status = response["status"]?.Value<int>() ?? 0;
            var mimeType = response["mimeType"]?.ToString();

            session.ResponseInfos[requestId] = new ResponseInfo { Status = status, Headers = headers, MimeType = mimeType };
        }

        private void HandleLoadingFinished(string sessionId, JToken p)
        {
            SessionInfo session;
            if (!_sessions.TryGetValue(sessionId, out session)) return;

            var requestId = p["requestId"]?.ToString();
            if (requestId == null) return;

            RequestData reqData;
            if (!session.PendingRequests.TryRemove(requestId, out reqData)) return;

            ResponseInfo respInfo;
            session.ResponseInfos.TryRemove(requestId, out respInfo);

            var capturedRequestId = requestId;
            var capturedSessionId = sessionId;
            Task.Run(async () =>
            {
                string body = null;
                try
                {
                    var getBodyParams = new Dictionary<string, object> { ["requestId"] = capturedRequestId };
                    var result = await SendSessionCommandAsync(capturedSessionId, "Network.getResponseBody", getBodyParams);
                    if (result != null && result["body"] != null)
                    {
                        body = result["body"].ToString();
                        var b64 = result["base64Encoded"];
                        if (b64 != null && b64.Value<bool>())
                            body = $"[Binary: {(body != null ? body.Length : 0)} bytes base64]";
                    }
                }
                catch { }

                var transaction = new CapturedTransaction
                {
                    Id = capturedRequestId,
                    Timestamp = DateTime.UtcNow,
                    Request = reqData,
                    Response = new ResponseData
                    {
                        StatusCode = respInfo != null ? respInfo.Status : 0,
                        Headers = respInfo != null ? respInfo.Headers : new Dictionary<string, string>(),
                        Body = body,
                        MimeType = respInfo != null ? respInfo.MimeType : null
                    }
                };

                DebugConsole.WriteLine($"[RES] {(respInfo != null ? respInfo.Status : 0)} {reqData.Url}");
                _sendToServer(transaction);
            });
        }

        private void HandleLoadingFailed(string sessionId, JToken p)
        {
            SessionInfo session;
            if (!_sessions.TryGetValue(sessionId, out session)) return;

            var requestId = p["requestId"]?.ToString();
            if (requestId == null) return;

            RequestData reqData;
            if (!session.PendingRequests.TryRemove(requestId, out reqData)) return;

            ResponseInfo removed;
            session.ResponseInfos.TryRemove(requestId, out removed);

            var errorText = p["errorText"]?.ToString() ?? "Failed";

            var transaction = new CapturedTransaction
            {
                Id = requestId,
                Timestamp = DateTime.UtcNow,
                Request = reqData,
                Response = new ResponseData
                {
                    StatusCode = 0,
                    Headers = new Dictionary<string, string>(),
                    Body = $"Failed: {errorText}",
                    MimeType = null
                }
            };

            DebugConsole.WriteLine($"[FAIL] {reqData.Url}");
            _sendToServer(transaction);
        }

        private void FlushPendingRequests(SessionInfo session)
        {
            foreach (var kvp in session.PendingRequests)
            {
                var reqData = kvp.Value;
                ResponseInfo respInfo;
                session.ResponseInfos.TryGetValue(kvp.Key, out respInfo);

                var transaction = new CapturedTransaction
                {
                    Id = kvp.Key,
                    Timestamp = DateTime.UtcNow,
                    Request = reqData,
                    Response = new ResponseData
                    {
                        StatusCode = respInfo?.Status ?? 0,
                        Headers = respInfo?.Headers ?? new Dictionary<string, string>(),
                        Body = "[Tab closed - response not captured]",
                        MimeType = respInfo?.MimeType
                    }
                };

                DebugConsole.WriteLine($"[FLUSH] {reqData.Url}");
                _sendToServer(transaction);
            }
            session.PendingRequests.Clear();
            session.ResponseInfos.Clear();
        }
    }
}
