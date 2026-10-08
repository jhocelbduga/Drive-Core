"use strict";

document.addEventListener("DOMContentLoaded", function () {
  var menuButton = document.querySelector(".menu-toggle");
  var navigation = document.querySelector(".primary-navigation");
  var searchForm = document.querySelector(".search-form");
  var searchInput = document.querySelector("#site-search");
  var searchFeedback = document.querySelector("#search-feedback");
  var productCards = Array.from(document.querySelectorAll(".product-card"));
  var basketCount = document.querySelector(".basket-count");
  var storeDialog = document.querySelector("#store-finder-dialog");
  var storeSearchForm = document.querySelector("#store-search-form");
  var store = window.DriveCoreStore;
  var cartFeedback = document.querySelector("#cart-feedback");
  function updateBasketCount() {
    if (basketCount) basketCount.textContent = String(store.count());
  }
  updateBasketCount();
  window.addEventListener("drivecore:change", updateBasketCount);
  if (store.error()) {
    cartFeedback.hidden = false;
    cartFeedback.setAttribute("role", "alert");
    cartFeedback.textContent = store.error();
  }

  var storeFinderButton = document.querySelector(".store-finder-trigger");
  if (storeFinderButton && storeDialog) {
    storeFinderButton.addEventListener("click", function () {
      storeDialog.showModal();
      document.querySelector("#store-location").focus();
    });

    storeDialog.querySelector(".store-dialog-close").addEventListener("click", function () {
      storeDialog.close();
      storeFinderButton.focus();
    });

    storeDialog.addEventListener("click", function (event) {
      if (event.target === storeDialog) {
        storeDialog.close();
        storeFinderButton.focus();
      }
    });
  }

  if (storeSearchForm) {
    storeSearchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var location = storeSearchForm.elements.location.value.trim();
      var mapsUrl = new URL("https://www.google.com/maps/search/");
      mapsUrl.searchParams.set("api", "1");
      mapsUrl.searchParams.set("query", "automotive parts stores near " + location);
      window.open(mapsUrl.toString(), "_blank", "noopener,noreferrer");
      storeDialog.close();
    });
  }

  if (menuButton && navigation) {
    menuButton.addEventListener("click", function () {
      var isOpen = menuButton.getAttribute("aria-expanded") !== "true";
      menuButton.setAttribute("aria-expanded", String(isOpen));
      navigation.classList.toggle("is-open", isOpen);
    });

    navigation.addEventListener("click", function (event) {
      if (event.target.closest("a") && window.matchMedia("(max-width: 620px)").matches) {
        menuButton.setAttribute("aria-expanded", "false");
        navigation.classList.remove("is-open");
      }
    });
  }

  if (searchForm && searchInput) {
    searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var query = searchInput.value.trim().toLowerCase();
      var visibleCount = 0;

      productCards.forEach(function (card) {
        var matches = !query || card.dataset.search.indexOf(query) !== -1;
        card.hidden = !matches;
        if (matches) visibleCount += 1;
      });

      if (searchFeedback) {
        searchFeedback.textContent = query
          ? (visibleCount ? "Showing " + visibleCount + " matching product" + (visibleCount === 1 ? "" : "s") + "." : "No featured products match that search. Try another term.")
          : "";
      }

      document.querySelector("#featured").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  document.querySelectorAll(".product-buy button").forEach(function (button) {
    button.addEventListener("click", function () {
      var product = store.products.find(function (entry) { return entry.id === button.dataset.product; });
      try {
        if (!product) throw new Error("This product is not available in the demo catalogue.");
        store.addItem(product.id, 1);
      } catch (error) {
        cartFeedback.hidden = false;
        cartFeedback.setAttribute("role", "alert");
        cartFeedback.textContent = error.message;
        return;
      }
      cartFeedback.hidden = false;
      cartFeedback.setAttribute("role", "status");
      cartFeedback.textContent = product.name + " added to your saved cart. Open Basket to review your order.";
      button.textContent = "Added";
      button.setAttribute("aria-label", "Add another " + product.name + " to basket");
    });
  });

  var plateForm = document.querySelector("#plate-form");
  if (plateForm) {
    plateForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var registration = document.querySelector("#registration");
      var message = document.querySelector("#plate-message");
      var normalizedRegistration = registration.value.trim().replace(/\s+/g, "");

      if (!/^[A-Za-z0-9]{2,7}$/.test(normalizedRegistration)) {
        registration.setCustomValidity("Enter a registration using 2 to 7 letters or numbers.");
        registration.reportValidity();
        return;
      }

      registration.setCustomValidity("");
      message.textContent = "Vehicle matching is a demo and is not connected to registration records yet.";
    });

    var registrationInput = document.querySelector("#registration");
    registrationInput.addEventListener("input", function () {
      registrationInput.setCustomValidity("");
    });
  }

  var vehicleForm = document.querySelector("#vehicle-select");
  if (vehicleForm) {
    vehicleForm.addEventListener("submit", function (event) {
      event.preventDefault();
      vehicleForm.querySelector(".vehicle-message").textContent =
        "Vehicle matching is a demo and is not connected to a live parts catalogue yet.";
    });
  }
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) window.location.reload();
  });
});
