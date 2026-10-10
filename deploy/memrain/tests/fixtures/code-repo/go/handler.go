package handler

import "example.com/fixture/store"

func Handle(v string) error {
	return store.Persist(v)
}
