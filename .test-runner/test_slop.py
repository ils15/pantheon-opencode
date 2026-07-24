"""Test that slop_test.py no longer contains AI-slop comments."""
import ast
import sys

TEST_FILE = ".test-runner/slop_test.py"


def test_no_verbose_class_comment():
    """Ensure the class has no verbose 'comprehensive' / 'CRUD' comments above it."""
    with open(TEST_FILE) as f:
        source = f.read()

    forbidden_phrases = [
        "comprehensive",
        "all CRUD operations",
        "proper error handling",
        "This function provides",
        "Initialize the service with",
        "This allows us to perform",
    ]
    for phrase in forbidden_phrases:
        assert phrase not in source, (
            f"AI slop detected: '{phrase}' should not appear in cleaned source"
        )


def test_code_is_valid_python():
    """Ensure the file is syntactically valid Python."""
    with open(TEST_FILE) as f:
        source = f.read()
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        pytest.fail(f"Invalid Python syntax: {exc}")


def test_class_and_method_preserved():
    """Ensure UserService class and __init__ are preserved."""
    with open(TEST_FILE) as f:
        source = f.read()
    tree = ast.parse(source)

    classes = [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]
    assert any(c.name == "UserService" for c in classes), "UserService class missing"

    class_body = [c for c in ast.walk(tree) if isinstance(c, ast.ClassDef)][0]
    methods = [n for n in ast.walk(class_body) if isinstance(n, ast.FunctionDef)]
    assert any(m.name == "__init__" for m in methods), "__init__ method missing"

    # Verify __init__ still has one parameter besides self
    init_method = [m for m in methods if m.name == "__init__"][0]
    assert len(init_method.args.args) >= 2, "__init__ must accept at least 'self' and 'db'"
    assert init_method.args.args[1].arg == "db", "Second parameter must be named 'db'"
