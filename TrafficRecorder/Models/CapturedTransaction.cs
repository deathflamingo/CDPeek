using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace TrafficRecorder.Models
{
    public class CapturedTransaction
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("timestamp")]
        public DateTime Timestamp { get; set; }

        [JsonProperty("request")]
        public RequestData Request { get; set; }

        [JsonProperty("response")]
        public ResponseData Response { get; set; }
    }

    public class RequestData
    {
        [JsonProperty("url")]
        public string Url { get; set; }

        [JsonProperty("method")]
        public string Method { get; set; }

        [JsonProperty("headers")]
        public Dictionary<string, string> Headers { get; set; }

        [JsonProperty("body")]
        public string Body { get; set; }
    }

    public class ResponseData
    {
        [JsonProperty("statusCode")]
        public int StatusCode { get; set; }

        [JsonProperty("headers")]
        public Dictionary<string, string> Headers { get; set; }

        [JsonProperty("body")]
        public string Body { get; set; }

        [JsonProperty("mimeType")]
        public string MimeType { get; set; }
    }
}
