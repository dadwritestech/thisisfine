const cart = [];

for (const button of document.querySelectorAll("[data-product] button")) {
  button.addEventListener("click", () => {
    cart.push(button.closest("[data-product]").dataset.product);
  });
}
