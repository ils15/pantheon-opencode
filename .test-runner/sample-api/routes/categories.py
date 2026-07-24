"""Category CRUD endpoints."""
from fastapi import APIRouter
from db import SessionLocal
from models import Category
from schemas import CategoryCreate, CategoryResponse

router = APIRouter()


@router.get("/categories", response_model=list[CategoryResponse])
def get_categories() -> list[Category]:
    db = SessionLocal()
    categories = db.query(Category).all()
    db.close()
    return categories


@router.post("/categories", response_model=CategoryResponse)
def create_category(category: CategoryCreate) -> Category:
    db = SessionLocal()
    new_category = Category(name=category.name)
    db.add(new_category)
    db.commit()
    db.refresh(new_category)
    db.close()
    return new_category
