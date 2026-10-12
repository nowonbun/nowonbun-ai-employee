"""관리자용 OPERATOR_TOKEN을 생성해 .env에 붙여 넣을 형식으로 출력한다."""

import secrets


def generate_token() -> str:
    """32바이트의 암호학적 난수를 64자리 16진수 토큰으로 변환한다."""
    return secrets.token_hex(32)


def main() -> None:
    print(f"OPERATOR_TOKEN={generate_token()}")


if __name__ == "__main__":
    main()
