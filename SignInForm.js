"use strict";

document.addEventListener("DOMContentLoaded", function () {
  var panels = document.querySelectorAll("[data-panel]");
  var viewButtons = document.querySelectorAll("[data-view]");

  function showPanel(name, updateHistory) {
    if (!["signin", "register", "reset"].includes(name)) {
      name = "signin";
    }

    panels.forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== name;
      var message = panel.querySelector(".form-message");
      if (message) {
        message.textContent = "";
      }
    });

    var heading = document.querySelector('[data-panel="' + name + '"] h1');
    if (heading) {
      heading.focus();
    }

    if (updateHistory && window.location.hash !== "#" + name) {
      window.history.pushState({ accountView: name }, "", "#" + name);
    }
  }

  viewButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      showPanel(button.dataset.view, true);
    });
  });

  window.addEventListener("popstate", function () {
    showPanel(window.location.hash.slice(1), false);
  });

  document.querySelectorAll("[data-password-target]").forEach(function (button) {
    button.addEventListener("click", function () {
      var input = document.getElementById(button.dataset.passwordTarget);
      if (!input) {
        return;
      }

      var shouldShow = input.type === "password";
      input.type = shouldShow ? "text" : "password";
      button.textContent = shouldShow ? "Hide" : "Show";
      button.setAttribute("aria-label", shouldShow ? "Hide password" : "Show password");
      button.setAttribute("aria-pressed", String(shouldShow));
    });
  });

  var confirmation = document.getElementById("register-confirm-password");
  var password = document.getElementById("register-password");
  if (confirmation && password) {
    confirmation.addEventListener("input", function () {
      confirmation.setCustomValidity(
        confirmation.value && confirmation.value !== password.value
          ? "Passwords do not match."
          : ""
      );
    });

    password.addEventListener("input", function () {
      if (confirmation.value) {
        confirmation.setCustomValidity(
          confirmation.value !== password.value ? "Passwords do not match." : ""
        );
      }
    });
  }

  document.querySelectorAll(".account-form").forEach(function (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();

      if (!form.reportValidity()) {
        return;
      }

      var message = form.querySelector(".form-message");
      if (message) {
        message.textContent =
          "This form is ready to connect, but account services are not configured on this page.";
      }
    });
  });

  var initialView = window.location.hash.slice(1);
  showPanel(initialView, false);
});
