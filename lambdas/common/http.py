import json

_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
}

def ok(body):
    return {"statusCode": 200, "headers": _HEADERS, "body": json.dumps(body)}

def bad_request(message: str):
    return {"statusCode": 400, "headers": _HEADERS, "body": json.dumps({"error": message})}

def forbidden(message: str):
    return {"statusCode": 403, "headers": _HEADERS, "body": json.dumps({"error": message})}

def error(message: str):
    return {"statusCode": 500, "headers": _HEADERS, "body": json.dumps({"message": message})}
