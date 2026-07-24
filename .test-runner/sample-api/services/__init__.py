import logging

from sqlalchemy.orm import joinedload

from db import SessionLocal
from models import User, Product

logger = logging.getLogger(__name__)


def get_db():
    """Get a database session (context manager)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class UserService:
    """User database operations."""

    def get_all_users(self) -> list[User]:
        """Return all users."""
        db = SessionLocal()
        try:
            users = db.query(User).all()
            return users
        except Exception:
            logger.exception("Error getting users")
            return []
        finally:
            db.close()

    def get_user_by_id(self, user_id: int) -> User | None:
        """Return user by ID, or None."""
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.id == user_id).first()
            return user
        except Exception:
            logger.exception("Error getting user")
            return None
        finally:
            db.close()

    def create_user(self, email: str, name: str, password: str) -> User | None:
        """Create a new user."""
        db = SessionLocal()
        try:
            new_user = User(email=email, name=name, password=password)
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
            return new_user
        except Exception:
            db.rollback()
            logger.exception("Error creating user")
            return None
        finally:
            db.close()


class ProductService:
    """Product database operations."""

    def get_all_products(self) -> list[Product]:
        """Return all products (with owner)."""
        db = SessionLocal()
        try:
            products = db.query(Product).options(joinedload(Product.owner)).all()
            return products
        except Exception:
            logger.exception("Error getting products")
            return []
        finally:
            db.close()

    def get_product_by_id(self, product_id: int) -> Product | None:
        """Return product by ID, or None."""
        db = SessionLocal()
        try:
            product = (
                db.query(Product)
                .options(joinedload(Product.owner))
                .filter(Product.id == product_id)
                .first()
            )
            return product
        except Exception:
            logger.exception("Error getting product")
            return None
        finally:
            db.close()

    def create_product(self, name: str, description: str, price: float, owner_id: int) -> Product | None:
        """Create a new product."""
        db = SessionLocal()
        try:
            new_product = Product(
                name=name,
                description=description,
                price=price,
                owner_id=owner_id,
            )
            db.add(new_product)
            db.commit()
            db.refresh(new_product)
            return new_product
        except Exception:
            db.rollback()
            logger.exception("Error creating product")
            return None
        finally:
            db.close()
