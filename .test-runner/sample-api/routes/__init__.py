from fastapi import APIRouter
from sqlalchemy.orm import joinedload
from models import User, Product
from routes.health import router as health_router
from routes.categories import router as categories_router
from schemas import UserCreate, UserResponse, ProductCreate, ProductResponse
from db import SessionLocal

router = APIRouter()

# Include sub-routers
router.include_router(health_router)
router.include_router(categories_router)


@router.get("/users", response_model=list[UserResponse])
def get_users() -> list[User]:
    db = SessionLocal()
    users = db.query(User).all()
    db.close()
    return users


@router.get("/users/{user_id}", response_model=UserResponse)
def get_user(user_id: int) -> User | None:
    db = SessionLocal()
    user = db.query(User).filter(User.id == user_id).first()
    db.close()
    return user


@router.post("/users", response_model=UserResponse)
def create_user(user: UserCreate) -> User:
    db = SessionLocal()
    new_user = User(email=user.email, name=user.name, password=user.password)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    db.close()
    return new_user


@router.get("/products", response_model=list[ProductResponse])
def get_products() -> list[Product]:
    db = SessionLocal()
    products = db.query(Product).options(joinedload(Product.owner)).all()
    db.close()
    return products


@router.post("/products", response_model=ProductResponse)
def create_product(product: ProductCreate) -> Product:
    db = SessionLocal()
    new_product = Product(
        name=product.name,
        description=product.description,
        price=product.price,
        owner_id=product.owner_id,
    )
    db.add(new_product)
    db.commit()
    db.refresh(new_product)
    db.close()
    return new_product
