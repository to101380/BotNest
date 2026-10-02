const dialog = document.getElementById("line-guide-lightbox");
const preview = dialog.querySelector("img");
const close = dialog.querySelector("button");
document.querySelectorAll(".line-guide-picture").forEach(link => {
  link.setAttribute("aria-haspopup", "dialog");
  link.addEventListener("click", event => {
    event.preventDefault();
    preview.src = link.querySelector("img").src;
    preview.alt = link.querySelector("img").alt;
    dialog.showModal();
  });
});
close.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => preview.removeAttribute("src"));
