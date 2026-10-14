use serde::{Deserialize, Serialize};
use serde_json::Value;

fn request(method: reqwest::Method, path: &str) -> Result<reqwest::RequestBuilder, String> {
    let base = super::route::resolve(
        std::env::var("BIBIT_KNOWLEDGE_MODE").ok().as_deref(),
        std::env::var("BIBIT_RAGFLOW_URL").ok().as_deref(),
    )?;
    let builder = client()?.request(method, format!("{base}{path}"));
    Ok(builder)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRetrieveRequest {
    pub question: String,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRetrieveResponse {
    pub status: String,
    pub data: Option<Value>,
    pub error: Option<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("RAGFlow client failed: {e}"))
}

fn validate_body(status: reqwest::StatusCode, body: &Value) -> Result<(), String> {
    if !status.is_success() {
        return Err(format!("RAGFlow returned HTTP {status}"));
    }
    match body.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        Some(code) => Err(format!("RAGFlow returned error code {code}")),
        None => Err("invalid RAGFlow response: missing numeric code".into()),
    }
}

async fn response_body(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("RAGFlow returned HTTP {status}"));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("invalid RAGFlow response: {e}"))?;
    validate_body(status, &body)?;
    Ok(body)
}

fn required_text<'a>(item: &'a Value, field: &str) -> Result<&'a str, String> {
    item.get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| format!("invalid RAGFlow response: missing {field}"))
}

fn validate_chunks(body: &Value) -> Result<(), String> {
    let chunks = body
        .pointer("/data/chunks")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid RAGFlow response: missing chunks array".to_string())?;
    for chunk in chunks {
        for field in ["id", "content", "document_id", "document_keyword"] {
            required_text(chunk, field)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn knowledge_retrieve(
    request: KnowledgeRetrieveRequest,
) -> Result<KnowledgeRetrieveResponse, String> {
    let question = request.question.trim();
    if question.is_empty() {
        return Err("question is required".into());
    }
    if question.chars().count() > 16000 {
        return Err("question exceeds 16000 characters".into());
    }
    let response = self::request(reqwest::Method::POST, "/ragflow/retrieval")?
        .json(&serde_json::json!({
            "question": question,
            "page": request.page.unwrap_or(1).max(1),
            "page_size": request.page_size.unwrap_or(10).clamp(1, 100),
            "similarity_threshold": 0.2,
            "vector_similarity_weight": 0.3,
            "top_k": 1024,
            "keyword": true,
            "highlight": false,
        }))
        .send()
        .await
        .map_err(|e| format!("RAGFlow request failed: {e}"))?;

    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("请求过于频繁，请稍后再试".into());
    }

    let body = response_body(response).await?;
    validate_chunks(&body)?;
    Ok(KnowledgeRetrieveResponse {
        status: "succeeded".into(),
        data: Some(body),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn errors_are_not_empty_results() {
        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert!(validate_body(status, &json!({"code": 0})).is_err());
        }
        assert!(validate_body(reqwest::StatusCode::OK, &json!({"code": 102})).is_err());
        assert!(validate_body(reqwest::StatusCode::OK, &json!({})).is_err());
        assert!(validate_chunks(&json!({"data": {}})).is_err());
        assert!(validate_chunks(&json!({"data": {"chunks": [{"id": "c"}]}})).is_err());
        let empty = json!({"code": 0, "data": {"chunks": []}});
        assert!(validate_body(reqwest::StatusCode::OK, &empty).is_ok());
        assert!(validate_chunks(&empty).is_ok());
        assert!(validate_chunks(&json!({"data": {"chunks": [{
            "id": "c", "content": "text", "document_id": "d", "document_keyword": "manual"
        }]}}))
        .is_ok());
    }
}
